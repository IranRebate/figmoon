#!/usr/bin/env node

/**
 * Optional, advisory vision/OCR evidence for an isolated Figma parity run.
 * It never mutates Figma, production code, or a visual baseline.
 */

import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import OpenAI from 'openai';
import sharp from 'sharp';

import { getFigmoonConfig } from '../lib/config.mjs';
const __figmoonConfig = getFigmoonConfig();
const clientRoot = __figmoonConfig.clientRoot;
const repoRoot = __figmoonConfig.consumerRoot;
const maxInputs = 12;
const maxInputBytes = 24 * 1024 * 1024;
const maxEmptyResponseAttempts = 2;
const briefAnalysisCharacters = 24;
const tokenParamByModel = new Map([['gpt-5.6-luna', 'omit']]);
const defaultPrompt = [
  'You are reviewing one product screenshot as advisory evidence for a Figma parity investigation.',
  'First transcribe every readable text fragment exactly. Then describe only visible facts: major regions, controls, alignment, and obvious visual differences.',
  'Do not infer hidden code, do not propose a baseline update, and do not claim that the product matches Figma.',
  'Answer concisely in Persian.',
].join(' ');

function enabled(value) {
  return /^(1|true|yes)$/i.test(String(value ?? '').trim());
}

function requireValue(flag, value) {
  if (!value || value.startsWith('--')) throw new Error(`${flag} requires a value.`);
  return value;
}

function resolveInputPath(value) {
  if (isAbsolute(value)) return value;
  const candidates = [
    resolve(process.cwd(), value),
    resolve(repoRoot, value),
    resolve(clientRoot, value),
  ];
  return candidates.find((candidate) => existsSync(candidate)) ?? candidates[0];
}

function resolveOutputPath(value) {
  if (isAbsolute(value)) return value;
  if (/^(client|docs|server|extension)\//.test(value)) return resolve(repoRoot, value);
  return resolve(process.cwd(), value);
}

function usage() {
  console.log(`Usage:
  FIGMA_VISION_ENABLED=1 FIGMA_VISION_API_KEY=... FIGMA_VISION_BASE_URL=https://... \\
    node scripts/figma-vision-inspect.mjs --input reference=docs/design/figma/pages/example.png

Options:
  --input <label=path>   Repeatable named image input.
  --image <path>         Repeatable image input with an automatic label.
  --out <path>           Write the JSON evidence artifact instead of stdout.
  --max-parallel <1..4>  Maximum concurrent vision requests (default: 2).
  --allow-partial        Exit successfully when at least one input has evidence.
  --prompt <text>        Replace the advisory review prompt.

Environment:
  FIGMA_VISION_ENABLED=1
  FIGMA_VISION_API_KEY
  FIGMA_VISION_BASE_URL
  FIGMA_VISION_MODEL=gpt-5.6-luna
  FIGMA_VISION_MAX_TOKENS=450
  FIGMA_VISION_TOKEN_PARAM=auto  # default; pin a verified gateway to max_tokens or max_completion_tokens
  FIGMA_VISION_ALLOW_INSECURE_HTTP=1  # required only for an http:// endpoint
`);
}

function parseArgs(argv) {
  const inputs = [];
  let outPath = null;
  let maxParallel = 2;
  let allowPartial = false;
  let prompt = defaultPrompt;

  const addInput = (label, value) => {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/.test(label)) {
      throw new Error(`Invalid input label '${label}'.`);
    }
    inputs.push({ label, path: resolveInputPath(requireValue('--input', value)) });
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--help' || arg === '-h') return { help: true };
    if (arg === '--input' || arg.startsWith('--input=')) {
      const raw =
        arg === '--input' ? requireValue('--input', argv[++index]) : arg.slice('--input='.length);
      const separator = raw.indexOf('=');
      if (separator < 1) throw new Error('--input must use label=path.');
      addInput(raw.slice(0, separator), raw.slice(separator + 1));
      continue;
    }
    if (arg === '--image' || arg.startsWith('--image=')) {
      const path =
        arg === '--image' ? requireValue('--image', argv[++index]) : arg.slice('--image='.length);
      const stem = basename(path).replace(/\.[^.]+$/, '') || 'image';
      const duplicateCount = inputs.filter((input) => input.label === stem).length;
      addInput(duplicateCount ? `${stem}-${duplicateCount + 1}` : stem, path);
      continue;
    }
    if (arg === '--out' || arg.startsWith('--out=')) {
      const path = arg === '--out' ? requireValue('--out', argv[++index]) : arg.slice('--out='.length);
      outPath = resolveOutputPath(path);
      continue;
    }
    if (arg === '--max-parallel' || arg.startsWith('--max-parallel=')) {
      const raw =
        arg === '--max-parallel'
          ? requireValue('--max-parallel', argv[++index])
          : arg.slice('--max-parallel='.length);
      maxParallel = Number(raw);
      if (!Number.isInteger(maxParallel) || maxParallel < 1 || maxParallel > 4) {
        throw new Error('--max-parallel must be an integer from 1 through 4.');
      }
      continue;
    }
    if (arg === '--allow-partial') {
      allowPartial = true;
      continue;
    }
    if (arg === '--prompt' || arg.startsWith('--prompt=')) {
      prompt =
        arg === '--prompt'
          ? requireValue('--prompt', argv[++index])
          : requireValue('--prompt', arg.slice('--prompt='.length));
      continue;
    }
    throw new Error(`Unsupported figma:vision argument: ${arg}`);
  }

  if (!inputs.length) throw new Error('figma:vision requires at least one --input or --image.');
  if (inputs.length > maxInputs) throw new Error(`figma:vision accepts at most ${maxInputs} images.`);
  if (new Set(inputs.map((input) => input.label)).size !== inputs.length) {
    throw new Error('figma:vision input labels must be unique.');
  }
  return { inputs, outPath, maxParallel, allowPartial, prompt };
}

function parseConfig() {
  if (!enabled(process.env.FIGMA_VISION_ENABLED)) {
    throw new Error('figma:vision is disabled. Set FIGMA_VISION_ENABLED=1 to opt in.');
  }

  const apiKey = process.env.FIGMA_VISION_API_KEY?.trim();
  const baseUrl = process.env.FIGMA_VISION_BASE_URL?.trim();
  if (!apiKey) throw new Error('FIGMA_VISION_API_KEY is required when FIGMA_VISION_ENABLED=1.');
  if (!baseUrl) throw new Error('FIGMA_VISION_BASE_URL is required when FIGMA_VISION_ENABLED=1.');

  let parsedUrl;
  try {
    parsedUrl = new URL(baseUrl);
  } catch {
    throw new Error('FIGMA_VISION_BASE_URL must be an absolute URL.');
  }
  if (parsedUrl.username || parsedUrl.password || parsedUrl.search || parsedUrl.hash) {
    throw new Error('FIGMA_VISION_BASE_URL must not embed credentials, query parameters, or a fragment.');
  }
  if (parsedUrl.protocol === 'http:' && !enabled(process.env.FIGMA_VISION_ALLOW_INSECURE_HTTP)) {
    throw new Error(
      'Refusing plaintext vision transport. Use HTTPS or set FIGMA_VISION_ALLOW_INSECURE_HTTP=1 explicitly.'
    );
  }
  if (!['https:', 'http:'].includes(parsedUrl.protocol)) {
    throw new Error('FIGMA_VISION_BASE_URL must use https:// or explicit opt-in http://.');
  }

  const maxTokens = Number(process.env.FIGMA_VISION_MAX_TOKENS ?? 450);
  if (!Number.isInteger(maxTokens) || maxTokens < 32 || maxTokens > 2_000) {
    throw new Error('FIGMA_VISION_MAX_TOKENS must be an integer from 32 through 2000.');
  }
  const model = process.env.FIGMA_VISION_MODEL?.trim() || 'gpt-5.6-luna';
  const tokenParamSetting = process.env.FIGMA_VISION_TOKEN_PARAM?.trim() || 'auto';
  if (!['auto', 'max_tokens', 'max_completion_tokens', 'omit'].includes(tokenParamSetting)) {
    throw new Error(
      'FIGMA_VISION_TOKEN_PARAM must be auto, max_tokens, max_completion_tokens, or omit.'
    );
  }
  const preferredTokenParam = tokenParamByModel.get(model) ?? 'max_tokens';
  const tokenParams =
    tokenParamSetting === 'auto'
      ? [...new Set([preferredTokenParam, preferredTokenParam === 'max_tokens' ? 'max_completion_tokens' : 'max_tokens'])]
      : [tokenParamSetting];

  return {
    apiKey,
    baseUrl: `${parsedUrl.origin}${parsedUrl.pathname.replace(/\/+$/, '')}`,
    model,
    maxTokens,
    tokenParamSetting,
    tokenParams,
    protocol: parsedUrl.protocol.slice(0, -1),
    insecureHttpOptIn: parsedUrl.protocol === 'http:',
  };
}

function repoPath(path) {
  const rel = relative(repoRoot, path);
  return rel && !rel.startsWith('..') && !isAbsolute(rel) ? rel : basename(path);
}

function redact(value, apiKey) {
  return String(value ?? '')
    .replaceAll(apiKey, '[redacted]')
    .replace(/\bsk-[A-Za-z0-9_-]+\b/g, '[redacted]')
    .slice(0, 1_200);
}

function responseText(content) {
  if (typeof content === 'string') return content.trim();
  if (Array.isArray(content)) {
    return content
      .map((item) => (typeof item === 'string' ? item : item?.text ?? ''))
      .join('\n')
      .trim();
  }
  return '';
}

async function inspectPreparedImage(client, config, prompt, label, dataUrl) {
  let attempts = 0;
  let lastError = null;
  for (let retry = 0; retry < maxEmptyResponseAttempts; retry += 1) {
    for (const tokenParam of config.tokenParams) {
      attempts += 1;
      try {
        const request = {
          model: config.model,
          temperature: 0,
          messages: [
            {
              role: 'user',
              content: [
                { type: 'text', text: `${prompt}\n\nImage label: ${label}` },
                { type: 'image_url', image_url: { url: dataUrl, detail: 'high' } },
              ],
            },
          ],
        };
        if (tokenParam !== 'omit') request[tokenParam] = config.maxTokens;
        const completion = await client.chat.completions.create(request);
        const analysis = responseText(completion.choices[0]?.message?.content);
        if (analysis) {
          return {
            analysis,
            attempts,
            tokenParam,
            completeness: analysis.length < briefAnalysisCharacters ? 'brief' : 'substantive',
          };
        }
      } catch (error) {
        lastError = error;
      }
    }
  }
  if (lastError) throw lastError;
  throw new Error(`Vision provider returned an empty response after ${attempts} attempt(s).`);
}

async function prepareImage(input) {
  const details = await stat(input.path);
  if (!details.isFile()) throw new Error('Input is not a regular file.');
  if (details.size > maxInputBytes) {
    throw new Error(`Input exceeds the ${Math.round(maxInputBytes / 1024 / 1024)} MB limit.`);
  }

  const source = await readFile(input.path);
  const metadata = await sharp(source, { limitInputPixels: 40_000_000 }).metadata();
  if (!metadata.width || !metadata.height) throw new Error('Input does not contain a decodable image.');

  const prepared = await sharp(source, { limitInputPixels: 40_000_000 })
    .rotate()
    .resize({ width: 1_600, height: 1_600, fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality: 88, mozjpeg: true })
    .toBuffer({ resolveWithObject: true });

  return {
    source,
    dataUrl: `data:image/jpeg;base64,${prepared.data.toString('base64')}`,
    sourceBytes: details.size,
    sourceDimensions: { width: metadata.width, height: metadata.height },
    preparedBytes: prepared.data.length,
    preparedDimensions: { width: prepared.info.width, height: prepared.info.height },
  };
}

async function mapLimit(items, limit, callback) {
  const results = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (true) {
      const index = next++;
      if (index >= items.length) return;
      results[index] = await callback(items[index], index);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

const options = parseArgs(process.argv.slice(2));
if (options.help) {
  usage();
  process.exit(0);
}

const config = parseConfig();
const client = new OpenAI({
  apiKey: config.apiKey,
  baseURL: config.baseUrl,
  timeout: 75_000,
  maxRetries: 0,
});

const results = await mapLimit(options.inputs, options.maxParallel, async (input) => {
  const record = { label: input.label, sourcePath: repoPath(input.path) };
  try {
    const prepared = await prepareImage(input);
    const inspected = await inspectPreparedImage(
      client,
      config,
      options.prompt,
      input.label,
      prepared.dataUrl
    );
    return {
      ...record,
      status: 'ok',
      sourceSha256: createHash('sha256').update(prepared.source).digest('hex'),
      sourceBytes: prepared.sourceBytes,
      sourceDimensions: prepared.sourceDimensions,
      preparedBytes: prepared.preparedBytes,
      preparedDimensions: prepared.preparedDimensions,
      attempts: inspected.attempts,
      tokenParam: inspected.tokenParam,
      completeness: inspected.completeness,
      analysis: inspected.analysis,
    };
  } catch (error) {
    return {
      ...record,
      status: 'error',
      error: redact(error instanceof Error ? error.message : error, config.apiKey),
    };
  }
});

const evidence = {
  version: 1,
  generatedAt: new Date().toISOString(),
  claim: 'Advisory visual/OCR evidence only. It cannot establish Figma parity or authorize a baseline update.',
  configuredModel: config.model,
  tokenParamStrategy: config.tokenParamSetting,
  preferredTokenParam: config.tokenParams[0],
  transport: {
    protocol: config.protocol,
    insecureHttpOptIn: config.insecureHttpOptIn,
  },
  maxParallel: options.maxParallel,
  allowPartial: options.allowPartial,
  results,
};

if (options.outPath) {
  await mkdir(dirname(options.outPath), { recursive: true });
  await writeFile(options.outPath, `${JSON.stringify(evidence, null, 2)}\n`);
  console.log(`Vision evidence: ${repoPath(options.outPath)}`);
} else {
  console.log(JSON.stringify(evidence, null, 2));
}

const successfulInputs = results.filter((result) => result.status === 'ok').length;
if (results.some((result) => result.status === 'error') && (!options.allowPartial || successfulInputs === 0)) {
  process.exitCode = 1;
}
