/* Copyright (c) 2026 arfanayub0. All rights reserved. Licensed under the NEXUS Proprietary Perpetual License. See LICENSE. */

/**
 * Main-process file logging. The ONLY place a stack trace or SQL text is
 * allowed to land: `%APPDATA%/nexus/logs/main.log`. Nothing written here may
 * ever be sent to the renderer (CONVENTIONS §6).
 */

import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { app } from 'electron';

let resolvedLogDir: string | null = null;
let resolvedLogFile: string | null = null;

/** `%APPDATA%/nexus/logs` — created on first write. */
export function logDirectory(): string {
  if (resolvedLogDir) return resolvedLogDir;
  try {
    resolvedLogDir = path.join(app.getPath('userData'), 'logs');
  } catch {
    resolvedLogDir = path.join(process.cwd(), 'logs');
  }
  return resolvedLogDir;
}

/** Absolute path of `main.log`. */
export function logFile(): string {
  if (resolvedLogFile) return resolvedLogFile;
  resolvedLogFile = path.join(logDirectory(), 'main.log');
  return resolvedLogFile;
}

function serialise(value: unknown): string {
  if (value instanceof Error) {
    return `${value.name}: ${value.message}\n${value.stack ?? '(no stack)'}`;
  }
  if (typeof value === 'object' && value !== null) {
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  }
  return String(value);
}

function write(level: 'INFO' | 'WARN' | 'ERROR', scope: string, message: string): void {
  const line = `${new Date().toISOString()} ${level} [${scope}] ${message}\n`;
  try {
    mkdirSync(logDirectory(), { recursive: true });
    appendFileSync(logFile(), line, 'utf8');
  } catch {
    // Logging must never take the app down.
  }
  if (level !== 'INFO') process.stderr.write(line);
}

/** Logs a caught error with its stack. Returns the message that was logged. */
export function logError(scope: string, error: unknown, meta?: Record<string, unknown>): string {
  const detail = serialise(error);
  const suffix = meta ? ` ${serialise(meta)}` : '';
  write('ERROR', scope, `${detail}${suffix}`);
  return detail;
}

/** Logs a warning. */
export function logWarn(scope: string, message: string): void {
  write('WARN', scope, message);
}

/** Logs an informational line (startup, migrations, paths). */
export function logInfo(scope: string, message: string): void {
  write('INFO', scope, message);
}

/** Returns the last `lines` lines of the log, for the diagnostics panel. */
export function readLogTail(lines = 200): readonly string[] {
  try {
    const content = readFileSync(logFile(), 'utf8');
    return content.split('\n').slice(-lines);
  } catch {
    return [];
  }
}
