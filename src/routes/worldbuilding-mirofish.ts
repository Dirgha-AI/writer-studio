/**
 * MiroShark HTTP Bridge — worldbuilding simulation via MiroShark service.
 *
 * MiroShark is licensed AGPL-3.0. This file communicates with it via HTTP only.
 * Never import MiroShark code directly — AGPL requires source disclosure for any
 * derivative work that runs as a network service.
 *
 * Enable by setting MIROFISH_URL in gateway .env (e.g. http://localhost:8400).
 * When unset, the worldbuilding routes fall back to AI simulation.
 */

export function isMiroSharkEnabled(): boolean {
  return !!process.env.MIROFISH_URL;
}

export async function miroSharkExtract(content: string): Promise<any> {
  const url = `${process.env.MIROFISH_URL}/extract`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: content }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`MiroShark /extract failed: ${res.status} ${body.slice(0, 200)}`);
  }
  return res.json();
}

export async function miroSharkSimulate(
  entities: any,
  scenario: string,
  steps: number = 10,
): Promise<any> {
  const url = `${process.env.MIROFISH_URL}/simulate`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ entities, scenario, steps }),
    signal: AbortSignal.timeout(60_000),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`MiroShark /simulate failed: ${res.status} ${body.slice(0, 200)}`);
  }
  return res.json();
}

export async function miroSharkGenerateScenes(
  plot_points: any[],
  style: string = 'narrative',
): Promise<any> {
  const url = `${process.env.MIROFISH_URL}/generate-scenes`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ plot_points, style }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`MiroShark /generate-scenes failed: ${res.status} ${body.slice(0, 200)}`);
  }
  return res.json();
}
