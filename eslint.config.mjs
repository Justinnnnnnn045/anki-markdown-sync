import tseslint from 'typescript-eslint';
import { fileURLToPath } from 'node:url';

const rootDir = fileURLToPath(new URL('.', import.meta.url));

export default tseslint.config(
	{
		ignores: ['node_modules/', 'main.js', 'esbuild.config.mjs'],
	},
	...tseslint.configs.recommendedTypeChecked,
	{
		files: ['**/*.ts'],
		languageOptions: {
			parserOptions: {
				project: './tsconfig.json',
				tsconfigRootDir: rootDir,
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
			'@typescript-eslint/no-require-imports': 'error',
			'@typescript-eslint/restrict-template-expressions': 'error',
			'@typescript-eslint/no-base-to-string': 'error',
		},
	},
);