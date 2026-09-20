# @scos/typescript-config

The shared TypeScript compiler policy. One file, `base.json`, extended by every
package in the workspace so the rules are identical everywhere and are changed
in one place.

It is a private workspace package rather than a copied file so that Turbo can
treat it as a dependency: it is registered as a global dependency, which means
a change to the compiler policy invalidates the cached `build` and `typecheck`
tasks of every package that extends it.

## Using it

Each package's `tsconfig.json` extends the base and adds only what is local to
it (its `rootDir`, `outDir`, `include` and any path mapping):

```jsonc
{
  "extends": "@scos/typescript-config/base.json",
  "compilerOptions": { "outDir": "dist", "rootDir": "src" },
  "include": ["src"],
}
```

## What the base sets, and why it matters

| Option                                          | Effect                                                                                                                                      |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `strict`                                        | The whole strict family, including `strictNullChecks`                                                                                       |
| `noUncheckedIndexedAccess`                      | An index access yields `T \| undefined`, so array and record lookups must be checked before use                                             |
| `exactOptionalPropertyTypes`                    | `{ a?: string }` does not silently accept an explicit `undefined`, keeping "absent" and "present but undefined" distinct                    |
| `verbatimModuleSyntax`                          | Type-only imports must say `import type`, so emitted imports match what was written                                                         |
| `isolatedModules`                               | Every file must be transpilable on its own, which is what the esbuild and tsdown builds rely on                                             |
| `module: Preserve`, `moduleResolution: Bundler` | ESM as authored, resolved the way the bundlers resolve it                                                                                   |
| `target: ES2024`                                | The floor is Node.js 24, pinned in `.node-version`                                                                                          |
| `declaration`, `declarationMap`, `sourceMap`    | The library packages publish `.d.ts` and maps from `dist`; declarations come from the compiler, while the JavaScript comes from the bundler |
| `forceConsistentCasingInFileNames`              | A case-only import mismatch fails here rather than on a case-sensitive CI filesystem                                                        |
| `types: ["node"]`                               | Only Node.js globals are ambient; a package needing more adds them itself                                                                   |

Emitting is the bundlers' job — tsdown for the libraries, esbuild for the API.
`tsc` is used only as the type checker (`--noEmit`) and to emit declarations.
See [build tooling](../../docs/local-development.md#build-tooling).
