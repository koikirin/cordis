import { Context, EffectScope } from '@cordisjs/core'
import { Dict, isNullable } from 'cosmokit'
import { ModuleLoader } from './internal.ts'
import { Entry, EntryOptions, EntryUpdateMeta } from './entry.ts'
import { ImportTree, LoaderFile } from './file.ts'
import * as inject from './inject.ts'

export * from './entry.ts'
export * from './file.ts'
export * from './group.ts'
export * from './tree.ts'

declare module '@cordisjs/core' {
  interface Events {
    'exit'(signal: NodeJS.Signals): Promise<void>
    'loader/config-update'(): void
    'loader/entry-fork'(entry: Entry, type: string): void
    'loader/entry-check'(entry: Entry): boolean | undefined
    'loader/partial-dispose'(entry: Entry, legacy: Partial<EntryOptions>, active: boolean): void
    'loader/context-init'(entry: Entry, ctx: Context): void
    'loader/before-patch'(this: EntryUpdateMeta, entry: Entry, ctx: Context): void
    'loader/after-patch'(this: EntryUpdateMeta, entry: Entry, ctx: Context): void
  }

  interface Context {
    baseDir: string
    loader: Loader
  }

  interface EnvData {
    startTime?: number
  }

  // Theoretically, these properties will only appear on `ForkScope`.
  // We define them directly on `EffectScope` for typing convenience.
  interface EffectScope {
    entry?: Entry
  }
}

export namespace Loader {
  export interface Config {
    name: string
    initial?: Omit<EntryOptions, 'id'>[]
    filename?: string
  }
}

export abstract class Loader extends ImportTree {
  // TODO auto inject optional when provided?
  static inject = {
    optional: ['loader'],
  }

  // process
  public envData = process.env.CORDIS_SHARED
    ? JSON.parse(process.env.CORDIS_SHARED)
    : { startTime: Date.now() }

  public params = {
    env: process.env,
  }

  public files: Dict<LoaderFile> = Object.create(null)
  public delims: Dict<symbol> = Object.create(null)
  public internal?: ModuleLoader

  constructor(public ctx: Context, public config: Loader.Config) {
    super(ctx)

    ctx.set('loader', this)

    ctx.on('internal/update', (fork) => {
      if (!fork.entry) return
      fork.parent.emit('loader/entry-fork', fork.entry, 'reload')
    })

    ctx.on('internal/before-update', (fork, config) => {
      if (!fork.entry) return
      if (fork.entry.suspend) return fork.entry.suspend = false
      const { schema } = fork.runtime
      fork.entry.options.config = schema ? schema.simplify(config) : config
      fork.entry.parent.tree.write()
    })

    ctx.on('internal/fork', (fork) => {
      // 1. set `fork.entry`
      if (fork.parent[Entry.key]) {
        fork.entry = fork.parent[Entry.key]
        delete fork.parent[Entry.key]
      }

      // 2. handle self-dispose
      // We only care about `ctx.scope.dispose()`, so we need to filter out other cases.

      // case 1: fork is created
      if (fork.uid) return

      // case 2: fork is not tracked by loader
      if (!fork.entry) return

      // case 3: fork is disposed on behalf of plugin deletion (such as plugin hmr)
      // self-dispose: ctx.scope.dispose() -> fork / runtime dispose -> delete(plugin)
      // plugin hmr: delete(plugin) -> runtime dispose -> fork dispose
      if (!ctx.registry.has(fork.runtime.plugin)) return

      fork.entry.fork = undefined
      fork.parent.emit('loader/entry-fork', fork.entry, 'unload')

      // case 4: fork is disposed by loader behavior
      // such as inject checker, config file update, ancestor group disable
      if (!fork.entry._check()) return

      fork.entry.options.disabled = true
      fork.entry.parent.tree.write()
    })

    ctx.plugin(inject)
  }

  async start() {
    await this.init(process.cwd(), this.config)
    await super.start()
  }

  locate(ctx = this[Context.current]) {
    return this._locate(ctx.scope).map(entry => entry.id)
  }

  _locate(scope: EffectScope): Entry[] {
    // root scope
    if (!scope.runtime.plugin) return []

    // runtime scope
    if (scope.runtime === scope) {
      return scope.runtime.children.flatMap(child => this._locate(child))
    }

    if (scope.entry) return [scope.entry]
    return this._locate(scope.parent.scope)
  }

  exit() {}

  unwrapExports(exports: any) {
    if (isNullable(exports)) return exports
    exports = exports.default ?? exports
    // https://github.com/evanw/esbuild/issues/2623
    // https://esbuild.github.io/content-types/#default-interop
    if (!exports.__esModule) return exports
    return exports.default ?? exports
  }
}

export default Loader
