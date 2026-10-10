/**
 * Zero-Leakage Sanitizer
 * Redacts secrets from summaries, error messages, and server logs.
 */

const REDACTED = '[REDACTADO]';

// Regex patterns specified in security guidelines:
// 1. Bearer tokens: "Bearer <token>"
// 2. OpenRouter style keys: "sk-or-..."
// 3. Evaluation feature/run tokens: "ftr_..."
const PATTERNS = [
  { regex: /Bearer\s+\S+/gi, replacement: `Bearer ${REDACTED}` },
  { regex: /sk-or-[A-Za-z0-9_.-]+/gi, replacement: REDACTED },
  { regex: /ftr_[A-Za-z0-9_.-]+/gi, replacement: REDACTED },
];

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Collects known environmental secrets dynamically to prevent leaking them.
 */
function getKnownEnvSecrets(): string[] {
  const candidates = [
    process.env.TEAM_TOKEN,
    process.env.OPENROUTER_API_KEY,
    process.env.DESKTOP_TOKEN,
    process.env.DESKTOP_PASSWORD,
  ];

  return candidates
    .filter((secret): secret is string => typeof secret === 'string' && secret.trim().length > 0)
    .map((s) => s.trim());
}

/**
 * Sanitizes input text by redacting secrets and sensitive patterns.
 * 
 * @param text The string or object to sanitize
 * @param taskPassword Optional desktop password specific to a task
 */
export function sanitize(text: unknown, taskPassword?: string): string {
  if (text === null || text === undefined) {
    return '';
  }

  let output = typeof text === 'string' ? text : String(text);

  // 1. Redact task-specific password (exact match for secrets of length >= 2)
  if (taskPassword && taskPassword.trim().length >= 2) {
    const escaped = escapeRegex(taskPassword.trim());
    output = output.replace(new RegExp(escaped, 'g'), REDACTED);
  }

  // 2. Redact global environment secrets (exact matches for secrets of length >= 2)
  const envSecrets = getKnownEnvSecrets();
  for (const secret of envSecrets) {
    if (secret.length >= 2) {
      const escaped = escapeRegex(secret);
      output = output.replace(new RegExp(escaped, 'g'), REDACTED);
    }
  }

  // 3. Apply regex pattern replacements
  for (const { regex, replacement } of PATTERNS) {
    output = output.replace(regex, replacement);
  }

  return output;
}

/**
 * Safe console logger that sanitizes any output.
 */
export const safeLogger = {
  info: (msg: unknown, taskPassword?: string) => {
    console.log(sanitize(msg, taskPassword));
  },
  warn: (msg: unknown, taskPassword?: string) => {
    console.warn(sanitize(msg, taskPassword));
  },
  error: (msg: unknown, taskPassword?: string) => {
    console.error(sanitize(msg, taskPassword));
  },
};
