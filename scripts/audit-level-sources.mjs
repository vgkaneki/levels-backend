import fs from 'node:fs/promises';
import path from 'node:path';
import {
  ALL_SOURCE_OVERLAP_CHECKED_METHODS,
  computeAllSourceOverlapData,
} from '../exported-levels-engine/dist/index.js';

const DEFAULT_SYMBOLS = ['BTC', 'ETH', 'SOL'];
const DEFAULT_INTERVALS = ['1m', '5m', '15m', '1h', '4h'];

function argValue(name, fallback) {
  const prefix = `--${name}=`;
  const found = process.argv.find((arg) => arg.startsWith(prefix));
  return found ? found.slice(prefix.length) : fallback;
}

function argList(name, fallback) {
  const raw = argValue(name, '');
  return raw ? raw.split(',').map((x) => x.trim()).filter(Boolean) : fallback;
}

function asNumber(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

const symbols = argList('symbols', DEFAULT_SYMBOLS);
const intervals = argList('intervals', DEFAULT_INTERVALS);
const minStrength = argValue('minStrength', 'developing');
const includeLive = argValue('includeLive', 'true') !== 'false';
const limit = Math.max(1, Math.min(80, asNumber(argValue('limit', '80'), 80)));
const liveBudgetMs = Math.max(50, Math.min(2000, asNumber(argValue('liveBudgetMs', '750'), 750)));
const outDir = argValue('outDir', 'reports/source-quality-audit');

function methodSetFromLevel(level) {
  const values = [];
  if (Array.isArray(level?.methods)) values.push(...level.methods);
  if (Array.isArray(level?.sourceIds)) values.push(...level.sourceIds);
  if (Array.isArray(level?.sources)) values.push(...level.sources);
  if (Array.isArray(level?.candidates)) values.push(...level.candidates.map((c) => c?.method));
  if (typeof level?.method === 'string') values.push(level.method);
  return Array.from(new Set(values.filter((v) => typeof v === 'string' && ALL_SOURCE_OVERLAP_CHECKED_METHODS.includes(v))));
}

function sideOf(level) {
  const text = String(level?.kind ?? level?.side ?? '').toLowerCase();
  if (text.includes('support') || text === 'bid' || text === 'buy') return 'support';
  if (text.includes('resistance') || text === 'ask' || text === 'sell') return 'resistance';
  return 'unknown';
}

function roundPrice(price) {
  const n = Number(price);
  if (!Number.isFinite(n)) return 'nan';
  return String(Math.round(n * 100) / 100);
}

function signatureFor(result) {
  return (result.levels ?? [])
    .map((level) => `${roundPrice(level.price)}:${sideOf(level)}:${methodSetFromLevel(level).sort().join('+')}`)
    .sort()
    .join('|');
}

function emptyMethodStats(method) {
  return {
    method,
    levelHits: 0,
    candidateHits: 0,
    soloHits: 0,
    supportHits: 0,
    resistanceHits: 0,
    unknownSideHits: 0,
    eliteHits: 0,
    strongHits: 0,
    developingHits: 0,
    origins: new Set(),
    sources: new Set(),
    symbols: new Set(),
    intervals: new Set(),
  };
}

function ensure(map, method) {
  if (!map.has(method)) map.set(method, emptyMethodStats(method));
  return map.get(method);
}

function absorbLevel(methodStats, level, symbol, interval) {
  const methods = methodSetFromLevel(level);
  const side = sideOf(level);
  const strength = String(level?.overlapStrength ?? '').toLowerCase();

  for (const method of methods) {
    const row = ensure(methodStats, method);
    row.levelHits += 1;
    row.soloHits += methods.length === 1 ? 1 : 0;
    row.supportHits += side === 'support' ? 1 : 0;
    row.resistanceHits += side === 'resistance' ? 1 : 0;
    row.unknownSideHits += side === 'unknown' ? 1 : 0;
    row.eliteHits += strength === 'elite' ? 1 : 0;
    row.strongHits += strength === 'strong' ? 1 : 0;
    row.developingHits += strength === 'developing' ? 1 : 0;
    row.symbols.add(symbol);
    row.intervals.add(interval);
  }

  for (const candidate of Array.isArray(level?.candidates) ? level.candidates : []) {
    const method = candidate?.method;
    if (!ALL_SOURCE_OVERLAP_CHECKED_METHODS.includes(method)) continue;
    const row = ensure(methodStats, method);
    row.candidateHits += 1;
    if (candidate?.source) row.sources.add(candidate.source);
    if (candidate?.originId) row.origins.add(candidate.originId);
  }
}

function finalizeMethod(row, totalRuns) {
  const coverageRuns = row.symbols.size * row.intervals.size;
  const warnings = [];
  if (row.levelHits === 0) warnings.push('missing from returned levels');
  if (row.candidateHits === 0) warnings.push('no candidate evidence returned');
  if (row.soloHits === 0 && row.levelHits > 0) warnings.push('no solo-source level coverage');
  if (row.unknownSideHits > 0) warnings.push('unknown/neutral side appears');
  if (row.origins.size <= 1 && row.candidateHits > 0) warnings.push('low independent-origin variety');
  if (coverageRuns > 0 && coverageRuns < Math.ceil(totalRuns * 0.25)) warnings.push('narrow market/timeframe coverage');

  let status = 'ok';
  if (row.levelHits === 0 || row.candidateHits === 0) status = 'missing';
  else if (warnings.length >= 2) status = 'needs-review';
  else if (warnings.length === 1) status = 'watch';

  return {
    method: row.method,
    status,
    levelHits: row.levelHits,
    candidateHits: row.candidateHits,
    soloHits: row.soloHits,
    supportHits: row.supportHits,
    resistanceHits: row.resistanceHits,
    unknownSideHits: row.unknownSideHits,
    eliteHits: row.eliteHits,
    strongHits: row.strongHits,
    developingHits: row.developingHits,
    originCount: row.origins.size,
    sourceCount: row.sources.size,
    symbolCoverage: Array.from(row.symbols).sort(),
    intervalCoverage: Array.from(row.intervals).sort(),
    warnings,
  };
}

function markdown(report) {
  const rows = report.methods.map((row) => `| ${row.method} | ${row.status} | ${row.levelHits} | ${row.candidateHits} | ${row.soloHits} | ${row.unknownSideHits} | ${row.originCount} | ${row.sourceCount} | ${row.warnings.join('; ') || '—'} |`).join('\n');
  const runRows = report.runs.map((run) => `| ${run.symbol} | ${run.interval} | ${run.ok ? 'ok' : 'error'} | ${run.levelCount} | ${run.candidateCount} | ${run.unknownSideCount} | ${run.error ?? '—'} |`).join('\n');
  return [
    '# 23 Source Quality Audit',
    '',
    `Generated: ${new Date(report.generatedAt).toISOString()}`,
    `Symbols: ${report.config.symbols.join(', ')}`,
    `Intervals: ${report.config.intervals.join(', ')}`,
    `Min strength: ${report.config.minStrength}`,
    `Include live: ${report.config.includeLive}`,
    `Limit: ${report.config.limit}`,
    '',
    '## Source status',
    '',
    '| Method | Status | Level Hits | Candidate Hits | Solo Hits | Unknown Side | Origins | Sources | Warnings |',
    '|---|---|---:|---:|---:|---:|---:|---:|---|',
    rows,
    '',
    '## Run coverage',
    '',
    '| Symbol | Interval | Status | Levels | Candidates | Unknown Side | Error |',
    '|---|---|---|---:|---:|---:|---|',
    runRows,
    '',
    '## Issues',
    '',
    ...report.issues.map((issue) => `- ${issue}`),
    '',
    '## Notes',
    '',
    '- This audit inspects evidence returned by the live engine without mutating scoring, cache, DOM, Bookmap, or confluence formulas.',
    '- A method can be coded but still marked missing if it produces no qualifying candidates for the selected markets/timeframes.',
    '- Solo hits are critical for judging standalone source quality; zero solo hits means the source is only being observed through confluence.',
  ].join('\n');
}

async function main() {
  const methodStats = new Map(ALL_SOURCE_OVERLAP_CHECKED_METHODS.map((method) => [method, emptyMethodStats(method)]));
  const runs = [];
  const signaturesBySymbol = new Map();

  for (const symbol of symbols) {
    const intervalSigs = new Map();
    for (const interval of intervals) {
      try {
        const result = await computeAllSourceOverlapData(symbol, interval, { minStrength, limit, includeLive, liveBudgetMs });
        const levels = Array.isArray(result?.levels) ? result.levels : [];
        const candidateCount = levels.reduce((sum, level) => sum + (Array.isArray(level?.candidates) ? level.candidates.length : 0), 0);
        const unknownSideCount = levels.filter((level) => sideOf(level) === 'unknown').length;
        for (const level of levels) absorbLevel(methodStats, level, symbol, interval);
        intervalSigs.set(interval, signatureFor(result));
        runs.push({ symbol, interval, ok: true, levelCount: levels.length, candidateCount, unknownSideCount });
      } catch (err) {
        runs.push({ symbol, interval, ok: false, levelCount: 0, candidateCount: 0, unknownSideCount: 0, error: err instanceof Error ? err.message : String(err) });
      }
    }
    signaturesBySymbol.set(symbol, intervalSigs);
  }

  const totalRuns = symbols.length * intervals.length;
  const methods = ALL_SOURCE_OVERLAP_CHECKED_METHODS.map((method) => finalizeMethod(methodStats.get(method), totalRuns));
  const issues = [];

  for (const row of methods) {
    if (row.status !== 'ok') issues.push(`${row.method}: ${row.status} (${row.warnings.join('; ')})`);
  }

  for (const [symbol, sigs] of signaturesBySymbol) {
    const nonEmpty = Array.from(sigs.entries()).filter(([, sig]) => sig.length > 0);
    const seen = new Map();
    for (const [interval, sig] of nonEmpty) {
      if (!seen.has(sig)) seen.set(sig, []);
      seen.get(sig).push(interval);
    }
    for (const [, groupedIntervals] of seen) {
      if (groupedIntervals.length > 1) {
        issues.push(`${symbol}: identical rounded level signatures across intervals ${groupedIntervals.join(', ')}; verify interval-specific source generation.`);
      }
    }
  }

  const report = {
    generatedAt: Date.now(),
    config: { symbols, intervals, minStrength, includeLive, limit, liveBudgetMs },
    expectedMethods: ALL_SOURCE_OVERLAP_CHECKED_METHODS,
    methods,
    runs,
    issues,
  };

  await fs.mkdir(outDir, { recursive: true });
  const stamp = new Date(report.generatedAt).toISOString().replace(/[:.]/g, '-');
  const jsonPath = path.join(outDir, `source-quality-audit-${stamp}.json`);
  const mdPath = path.join(outDir, `source-quality-audit-${stamp}.md`);
  await fs.writeFile(jsonPath, JSON.stringify(report, null, 2));
  await fs.writeFile(mdPath, markdown(report));

  console.log(`Wrote ${jsonPath}`);
  console.log(`Wrote ${mdPath}`);
  if (issues.length) {
    console.log('\nIssues:');
    for (const issue of issues) console.log(`- ${issue}`);
  } else {
    console.log('\nNo source-quality issues detected for this run.');
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
