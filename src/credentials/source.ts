import { realpath as nodeRealpath, stat as nodeStat } from 'node:fs/promises';
import { homedir as nodeHomedir } from 'node:os';
import { isAbsolute, relative, sep } from 'node:path';
import {
  discover,
  readCredentialFile,
  type DiscoverOptions,
} from './discover';
import type { OAuthCredentials } from './envelope';

export type FileCredentialSource = { kind: 'file'; path: string };

export type CredentialSource =
  | { kind: 'claude-code' }
  | FileCredentialSource;

export interface CredentialSourceOptions extends DiscoverOptions {
  realpathOverride?: typeof nodeRealpath;
  statOverride?: typeof nodeStat;
}

async function validateFilePath(
  filePath: string,
  options?: CredentialSourceOptions,
): Promise<string> {
  const realpathFn = options?.realpathOverride ?? nodeRealpath;
  const statFn = options?.statOverride ?? nodeStat;
  const home = options?.homedirOverride ?? nodeHomedir();

  let resolved: string;
  try {
    resolved = await realpathFn(filePath);
  } catch {
    throw new Error(
      `Credential source does not exist or cannot be resolved: ${filePath}`,
    );
  }

  let realHome: string;
  try {
    realHome = await realpathFn(home);
  } catch {
    throw new Error(`Home directory cannot be resolved: ${home}`);
  }

  const relativePath = relative(realHome, resolved);
  if (
    relativePath === '..' ||
    relativePath.startsWith(`..${sep}`) ||
    isAbsolute(relativePath)
  ) {
    throw new Error(
      `Credential source resolves outside home directory: ${resolved}`,
    );
  }

  let fileStat: Awaited<ReturnType<typeof nodeStat>>;
  try {
    fileStat = await statFn(resolved);
  } catch {
    throw new Error(`Credential source cannot be inspected: ${resolved}`);
  }
  if (!fileStat.isFile()) {
    throw new Error(`Credential source is not a regular file: ${resolved}`);
  }

  return resolved;
}

export async function canonicalizeFileCredentialSource(
  filePath: string,
  options?: CredentialSourceOptions,
): Promise<FileCredentialSource> {
  return {
    kind: 'file',
    path: await validateFilePath(filePath, options),
  };
}

export async function loadCredentialSource(
  source: CredentialSource,
  options?: CredentialSourceOptions,
): Promise<OAuthCredentials> {
  if (source.kind === 'claude-code') {
    return discover(options);
  }

  const resolved = await validateFilePath(source.path, options);
  const credentials = await readCredentialFile(
    resolved,
    options?.readFileOverride,
  );
  if (credentials === null) {
    throw new Error(`Credential source no longer exists: ${resolved}`);
  }
  return credentials;
}
