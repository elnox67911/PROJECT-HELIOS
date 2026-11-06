/** Glob patterns excluded from repository scanning, search, and tool listings. */
export const IGNORE_GLOBS = [
  "**/node_modules/**",
  "**/.git/**",
  "**/dist/**",
  "**/build/**",
  "**/.next/**",
  "**/coverage/**",
  "**/.helios/**",
  "**/.venv/**",
  "**/venv/**",
  "**/__pycache__/**",
  "**/target/**",
  "**/vendor/**",
  "**/*.lock",
  "**/*.map",
  "**/*.min.js",
];
