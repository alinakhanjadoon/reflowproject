import { NextRequest, NextResponse } from 'next/server';
import fs from 'fs';
import path from 'path';

export const dynamic = 'force-dynamic';

function findBinaryPath(fileNames: string | string[]): string | null {
  const names = Array.isArray(fileNames) ? fileNames : [fileNames];
  for (const fileName of names) {
    const candidatePaths = [
      path.resolve(process.cwd(), '../desktop/dist', fileName),
      path.resolve(process.cwd(), 'apps/desktop/dist', fileName),
      path.resolve(process.cwd(), 'dist', fileName),
      path.resolve(process.cwd(), '../../apps/desktop/dist', fileName)
    ];

    for (const candidate of candidatePaths) {
      try {
        if (fs.existsSync(/*turbopackIgnore: true*/ candidate)) {
          return candidate;
        }
      } catch {
        // Continue search on filesystem error
      }
    }
  }

  return null;
}

function nodeStreamToReadable(nodeStream: fs.ReadStream): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      nodeStream.on('data', (chunk: Buffer | string) => {
        const buffer = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
        controller.enqueue(new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength));
      });
      nodeStream.on('end', () => {
        controller.close();
      });
      nodeStream.on('error', (err) => {
        controller.error(err);
      });
    },
    cancel() {
      nodeStream.destroy();
    },
  });
}

export async function GET(request: NextRequest) {
  const searchParams = request.nextUrl.searchParams;
  const rawType = (searchParams.get('type') || 'installer').toLowerCase();
  const rawOs = (searchParams.get('os') || '').toLowerCase();

  const isMac = rawOs === 'mac' || rawOs === 'darwin' || rawType === 'dmg' || rawType === 'mac';
  const isPortable = rawType === 'portable' || rawType === 'zip';

  let candidateNames = ['ReFlow-Desktop-Setup-1.0.0.exe', 'ReFlow-Worker-Setup-1.0.0.exe'];

  if (isMac) {
    candidateNames = [
      'ReFlow-Desktop-Setup-1.0.0-mac-x64.dmg',
      'ReFlow-Desktop-1.0.0-mac-x64.dmg',
      'ReFlow-Desktop-1.0.0.dmg',
      'ReFlow-Desktop-1.0.0-mac-x64.zip',
      'ReFlow-Worker-Setup-1.0.0-mac-x64.dmg',
      'ReFlow-Worker-1.0.0-mac-x64.dmg',
      'ReFlow-Worker-1.0.0.dmg',
      'ReFlow-Worker-1.0.0-mac-x64.zip'
    ];
  } else if (isPortable) {
    candidateNames = ['ReFlow-Desktop-Portable-1.0.0.exe', 'ReFlow-Worker-Portable-1.0.0.exe'];
  }

  const binaryPath = findBinaryPath(candidateNames);
  const fileName = binaryPath ? path.basename(binaryPath) : candidateNames[0];

  if (binaryPath) {
    try {
      const stat = fs.statSync(/*turbopackIgnore: true*/ binaryPath);
      const readStream = fs.createReadStream(/*turbopackIgnore: true*/ binaryPath);
      const webStream = nodeStreamToReadable(readStream);

      return new NextResponse(webStream, {
        status: 200,
        headers: {
          'Content-Type': isMac ? 'application/x-apple-diskimage' : 'application/octet-stream',
          'Content-Disposition': `attachment; filename="${fileName}"`,
          'Content-Length': stat.size.toString(),
          'Cache-Control': 'public, max-age=86400',
        },
      });
    } catch (err: unknown) {
      const errorMsg = err instanceof Error ? err.message : 'Unknown stream error';
      return NextResponse.json(
        { error: 'Failed to stream binary file', details: errorMsg },
        { status: 500 }
      );
    }
  }

  // In production (Vercel) or when the local binary is not present on the host filesystem,
  // seamlessly redirect to the hosted GitHub Release asset or configured Cloud Storage URL.
  const customRemoteUrl = isMac
    ? process.env.DESKTOP_MAC_DOWNLOAD_URL
    : isPortable
    ? process.env.DESKTOP_PORTABLE_DOWNLOAD_URL
    : process.env.DESKTOP_WIN_DOWNLOAD_URL;

  const repoBase = process.env.NEXT_PUBLIC_GITHUB_REPO || 'https://github.com/alinakhanjadoon/reflowproject';
  const defaultGitHubReleaseUrl = `${repoBase}/releases/download/Desktop-app/${fileName}`;
  const redirectTarget = customRemoteUrl || defaultGitHubReleaseUrl;

  return NextResponse.redirect(redirectTarget, 302);
}
