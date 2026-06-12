The production Node package is built into a single `dist/index.js`, so moving command modules from
static imports to `import()` does not avoid reading/parsing that bundled file.
In fact, this can hurt startup time by adding async import
overhead without reducing the amount of code loaded. If startup is the target,
prefer reducing top-level work, deep-importing lighter helpers, externalizing
truly cold/heavy dependencies, or splitting actual runtime artifacts.
