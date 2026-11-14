import js from '@eslint/js'
import tseslint from 'typescript-eslint'
import reactHooks from 'eslint-plugin-react-hooks'
import globals from 'globals'

/**
 * 这套规则只干一件事：抓「一定会出错」的代码。
 *
 * 项目有 4.8 万行、从来没跑过 lint，如果一上来就开风格类规则（缩进、引号、排序），
 * 第一次跑会掉几千条，结果就是谁都不看、最后被 --no-verify 绕过 —— 那还不如没有。
 * 所以这里刻意只留两类：
 *   1. 正确性：hooks 调用顺序、重复 key、不可达代码、switch 穿透、空 catch 吞错；
 *   2. 架构边界：渲染层不许直接 import electron / node 内置模块。
 * 风格交给编辑器和人，不交给 lint。
 */
export default tseslint.config(
  {
    // 项目里已经有一批 eslint-disable 注释（多为编辑器自动加的），
    // 规则关掉后它们就成了「无用指令」。不为了消 warning 去改 4.8 万行代码。
    linterOptions: { reportUnusedDisableDirectives: 'off' },
    ignores: [
      'dist/**',
      'release/**',
      'node_modules/**',
      'build/**',
      'workspace/**',
      'tests/**',
      'tools/**',
      'scripts/**',
      'sdk/**'
    ]
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['src/**/*.{ts,tsx}'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: { ...globals.node, ...globals.browser },
      parserOptions: { ecmaFeatures: { jsx: true } }
    },
    plugins: { 'react-hooks': reactHooks },
    rules: {
      // hooks 调用顺序错了是运行期崩溃，必须拦
      'react-hooks/rules-of-hooks': 'error',
      // 依赖数组交给人和 tsc，开了会刷屏
      'react-hooks/exhaustive-deps': 'off',

      // 用 TS 版本，基础版会对类型位置误报
      'no-unused-vars': 'off',
      '@typescript-eslint/no-unused-vars': [
        'warn',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none' }
      ],

      // 这些在真实代码里是有意为之，不该拦
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-empty-object-type': 'off',
      '@typescript-eslint/no-non-null-assertion': 'off',
      '@typescript-eslint/ban-ts-comment': 'off',
      '@typescript-eslint/no-unused-expressions': 'off',

      // 真正会藏 bug 的几条
      'no-empty': ['error', { allowEmptyCatch: true }],
      'no-debugger': 'error',
      'no-dupe-keys': 'error',
      'no-dupe-class-members': 'off',
      'no-unreachable': 'error',
      'no-fallthrough': 'error',
      'no-constant-condition': ['error', { checkLoops: false }],
      'no-self-assign': 'error',
      'no-self-compare': 'error',
      'no-template-curly-in-string': 'warn',
      'no-unmodified-loop-condition': 'error',
      'require-atomic-updates': 'off',
      'no-async-promise-executor': 'error',
      'no-await-in-loop': 'off',
      'no-control-regex': 'off',
      'no-useless-escape': 'off',
      // 中文排版会用全角空格 / 不换行空格做间隔，JSX 文本节点里也算「不可见字符」，
      // 但那是刻意的。关掉，别让排版被当成错误。
      'no-irregular-whitespace': 'off'
    }
  },
  {
    // 主进程可以碰系统，但不该直接碰 DOM
    files: ['src/main/**/*.ts', 'src/shared/**/*.ts'],
    languageOptions: { globals: { ...globals.node } },
    rules: {
      'no-restricted-globals': [
        'error',
        { name: 'window', message: '主进程没有 window；需要窗口用 BrowserWindow' },
        { name: 'document', message: '主进程没有 document' }
      ]
    }
  },
  {
    // 渲染层没有 Node 权限，所有能力必须走 preload 暴露的 window.pico
    files: ['src/renderer/**/*.{ts,tsx}'],
    languageOptions: { globals: { ...globals.browser } },
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            { name: 'electron', message: '渲染层不能引 electron，能力走 window.pico' },
            { name: 'fs', message: '渲染层没有文件系统，走 window.pico.files' },
            { name: 'path', message: '渲染层没有 path，走 window.pico 暴露的结果' },
            { name: 'child_process', message: '渲染层不能起进程，走 window.pico.shell' },
            { name: 'os', message: '渲染层拿不到 os，走 window.pico 暴露的系统信息' },
            { name: 'crypto', message: '渲染层不做密钥/加密操作' }
          ],
          patterns: [
            {
              group: ['node:*', 'electron/*'],
              message: '渲染层只能用浏览器 API + window.pico'
            }
          ]
        }
      ]
    }
  }
)
