import { getRequestContext } from '@cloudflare/next-on-pages';
import { NextRequest, NextResponse } from 'next/server';

export const runtime = 'edge';

export async function GET() {
  const { env } = getRequestContext() as any;
  const vodData = await env.RERUN_STORE.get('vod_list');
  const vods = vodData ? JSON.parse(vodData) : [];
  return NextResponse.json(vods);
}

export async function POST(request: NextRequest) {
  const { env } = getRequestContext() as any;
  const { vodId, title } = (await request.json()) as { vodId: string; title?: string };

  if (!vodId) {
    return NextResponse.json({ error: 'VOD ID is required' }, { status: 400 });
  }

  const vodData = await env.RERUN_STORE.get('vod_list');
  const vods = vodData ? JSON.parse(vodData) : [];

  // Prevent duplicates
  if (!vods.some((v: any) => v.id === vodId)) {
    vods.push({ id: vodId, title: title || `VOD ${vodId}`, addedAt: new Date().toISOString() });
    await env.RERUN_STORE.put('vod_list', JSON.stringify(vods));
  }

  return NextResponse.json(vods);
}

export async function DELETE(request: NextRequest) {
  const { env } = getRequestContext() as any;
  const { searchParams } = new URL(request.url);
  const id = searchParams.get('id');

  if (!id) {
    return NextResponse.json({ error: 'ID is required' }, { status: 400 });
  }

  const vodData = await env.RERUN_STORE.get('vod_list');
  let vods = vodData ? JSON.parse(vodData) : [];
  vods = vods.filter((v: any) => v.id !== id);
  
  await env.RERUN_STORE.put('vod_list', JSON.stringify(vods));

  return NextResponse.json(vods);
}
