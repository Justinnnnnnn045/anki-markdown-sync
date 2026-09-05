const tseslint = require('typescript-eslint');

module.exports = tseslint.config(
	{
		ignores: ['node_modules/', 'main.js', 'esbuild.config.mjs', '*.config.*'],
	},
	...tseslint.configs.recommendedTypeChecked,
	{
		files: ['**/*.ts'],
		languageOptions: {
			parserOptions: {
				project: './tsconfig.json',
				tsconfigRootDir: __dirname,
			},
		},
		rules: {
			'@typescript-eslint/no-explicit-any': 'error',
			'@typescript-eslint/no-unsafe-return': 'error',
			'@typescript-eslint/no-unsafe-call': 'error',
			'@typescript-eslint/no-unsafe-member-access': 'error',
			'@typescript-eslint/no-unsafe-assignment': 'error',
			'@typescript-eslint/no-unsafe-argument': 'error',
			'@typescript-eslint/no-unnecessary-type-assertion': 'error',
			'@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
			'@typescript-eslint/restrict-template-expressions': 'error',
			'@typescript-eslint/no-base-to-string': 'error',
			'@typescript-eslint/no-require-imports': 'off',
		},
	}
);