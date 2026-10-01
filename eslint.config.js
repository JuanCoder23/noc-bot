const js = require('@eslint/js');

module.exports = [
  // Generated datasets and replay reports. Reproducible from a seed, never
  // committed, and not source.
  { ignores: ['out/**'] },
   js.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'commonjs',
      globals: {
        require: 'readonly',
        module: 'writable',
        exports: 'writable',
        __dirname: 'readonly',
        process: 'readonly',
        console: 'readonly',
      },
    },
  },
  {
    // src/parseAlert.js is extracted verbatim from the `Parsear Alerta` code
    // node so the tests exercise what actually runs. Its regexes escape `-`
    // inside character classes, which is harmless. Fixing it here would put
    // src/ and the workflow export out of sync for a cosmetic gain.
    files: ['src/parseAlert.js'],
    rules: { 'no-useless-escape': 'off' },
  },
];
