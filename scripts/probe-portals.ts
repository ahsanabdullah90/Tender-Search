/**
 * Probe Portals CLI Tool
 * Checks connectivity and HTTP status of all 18 configured portals.
 *
 * Run: npm run probe:portals
 */
import { PORTAL_DEFINITIONS } from '../src/server/scrapers/portalList.js';

interface ProbeResult {
  id: string;
  name: string;
  accessMode: string;
  httpStatus: string;
  latencyMs: number;
  detectedStatus: string;
  notes: string;
}

async function probeUrl(url: string): Promise<{ status: number | string; latency: number; bodyPreview: string; error?: string }> {
  const start = Date.now();
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 10000);

    // Using node-compatible fetch with custom dispatcher / agent if supported
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
      }
    } as any).finally(() => clearTimeout(timeoutId));

    const latency = Date.now() - start;
    const text = await res.text().catch(() => '');
    return { status: res.status, latency, bodyPreview: text.slice(0, 500) };
  } catch (err: any) {
    const latency = Date.now() - start;
    const msg = err.name === 'AbortError' ? 'TIMEOUT (10s)' : (err.code || err.message || 'Network Error');
    return { status: 'ERR', latency, bodyPreview: '', error: msg };
  }
}

async function runProbe() {
  console.log(`\n======================================================`);
  console.log(`  Tender Tracker - Portal Connectivity Health Probe   `);
  console.log(`  Probing ${PORTAL_DEFINITIONS.length} portals at ${new Date().toISOString()}...`);
  console.log(`======================================================\n`);

  const results: ProbeResult[] = [];

  for (const portal of PORTAL_DEFINITIONS) {
    process.stdout.write(`Checking ${portal.id.padEnd(20)} ... `);
    const targetUrl = portal.tendersUrl || portal.baseUrl;
    const probe = await probeUrl(targetUrl);

    let detectedStatus = 'online';
    let notes = '';

    if (portal.accessMode === 'offline_broken') {
      detectedStatus = 'offline_broken';
      notes = 'Known offline/unreachable portal';
    } else if (probe.status === 'ERR') {
      detectedStatus = 'error';
      notes = probe.error || 'Connection failed';
    } else if (typeof probe.status === 'number' && (probe.status === 403 || probe.status === 503)) {
      if (probe.bodyPreview.includes('cf-browser-verification') || probe.bodyPreview.includes('Turnstile') || probe.bodyPreview.includes('Cloudflare')) {
        detectedStatus = 'cloudflare';
        notes = 'Cloudflare challenge page';
      } else {
        detectedStatus = 'hitl_required';
        notes = `HTTP ${probe.status} access restriction`;
      }
    } else if (portal.accessMode === 'login_required') {
      detectedStatus = 'hitl_required';
      notes = 'Credentials or session required';
    } else if (typeof probe.status === 'number' && probe.status >= 200 && probe.status < 400) {
      detectedStatus = 'online';
      notes = `HTTP ${probe.status} OK`;
    } else {
      detectedStatus = 'error';
      notes = `HTTP ${probe.status}`;
    }

    results.push({
      id: portal.id,
      name: portal.name.slice(0, 30),
      accessMode: portal.accessMode,
      httpStatus: String(probe.status),
      latencyMs: probe.latency,
      detectedStatus,
      notes
    });

    console.log(`[${detectedStatus.toUpperCase()}] ${probe.latency}ms (${notes})`);
  }

  console.log('\n--- Summary Table ---');
  console.table(results.map(r => ({
    Portal: r.id,
    Name: r.name,
    Mode: r.accessMode,
    HTTP: r.httpStatus,
    'Latency (ms)': r.latencyMs,
    Status: r.detectedStatus,
    Notes: r.notes
  })));

  console.log(`\nProbe completed for ${results.length} portals.\n`);
}

// Run probe if invoked directly
if (process.argv[1]?.includes('probe-portals')) {
  runProbe().catch(err => {
    console.error('Probe failed:', err);
    process.exit(1);
  });
}

export { runProbe, probeUrl };
