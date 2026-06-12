/* eslint-disable no-undef */
import { transformAsync } from '@babel/core';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const inputFile = path.resolve(__dirname, '../lib/Tools.js');
const outputFile = path.resolve(__dirname, '../lib/esm/Tools.js');

/**
 * Babel plugin that turns the monolithic `const Tools = { ... }` object in
 * Tools.js into individually-exported, top-level declarations so bundlers
 * (esbuild/Bun) can tree-shake unused members.
 *
 * Why: `export const { a, b } = Tools` (the previous strategy) makes every
 * named export depend on the single `Tools` object literal, so the whole thing
 * is retained whenever any member is imported. Hoisting each member to its own
 * `export function` / `export const` lets the bundler drop the unused ones.
 *
 * How it works:
 * 1. Each Tools member becomes a top-level declaration:
 *    - regular methods  -> `export function name(...) { ... }`
 *    - value properties -> `export const name = <value>;`
 *    - the `_modules` shorthand keeps referencing the existing module-private
 *      top-level `_modules` binding (stays unexported, matching the old output).
 * 2. Every internal `Tools.<member>` reference is rewritten to a bare
 *    `<member>` identifier (function declarations hoist, so order is safe).
 * 3. `Tools` is rebuilt as a shorthand object `{ a, b, ... }` purely for the
 *    `export default Tools` back-compat surface. Because the `window._tools`
 *    trailer is dropped, nothing else references it, so the default export (and
 *    therefore the whole object) is dead-code-eliminated when consumers only
 *    use named imports.
 * 4. The CommonJS `module.exports = Tools` and browser `window._tools = Tools`
 *    trailers are removed, and a `createRequire` shim is injected for the
 *    `require(...)` calls the source relies on under ESM.
 *
 * @param {object} param0 - Babel types
 */
export const transformToolsToTreeShakeable = ({ types: t }) => {
   /** Names of every Tools member; used to rewrite `Tools.<name>` -> `<name>`. */
   const memberNames = new Set();
   /** Guard so the rebuilt (still ObjectExpression) `const Tools` isn't reprocessed. */
   let toolsProcessed = false;

   /** shorthand object property: `name` */
   const shorthand = (name) =>
      t.objectProperty(t.identifier(name), t.identifier(name), false, true);

   /** wrap a declaration with `export`, unless it's a module-private (`_`-prefixed) member */
   const exportIfPublic = (name, decl) =>
      name.startsWith('_') ? decl : t.exportNamedDeclaration(decl, []);

   /**
    * Whether an IfStatement is one of the CommonJS/browser export trailers
    * (`if (typeof module !== 'undefined') module.exports = Tools;` /
    * `if (typeof window !== 'undefined') window._tools = Tools;`).
    * Matched by the assignment target so guards inside methods are left alone.
    * @param {object} node - IfStatement node
    */
   const isExportTrailer = (node) => {
      let stmt = node.consequent;
      if (t.isBlockStatement(stmt)) stmt = stmt.body[0];
      if (!t.isExpressionStatement(stmt)) return false;
      const expr = stmt.expression;
      if (!t.isAssignmentExpression(expr) || !t.isMemberExpression(expr.left)) return false;
      const { object, property } = expr.left;
      return (
         (t.isIdentifier(object, { name: 'module' }) &&
            t.isIdentifier(property, { name: 'exports' })) ||
         (t.isIdentifier(object, { name: 'window' }) &&
            t.isIdentifier(property, { name: '_tools' }))
      );
   };

   return {
      visitor: {
         // Drop `module.exports = Tools` / `window._tools = Tools` trailers.
         IfStatement(p) {
            if (isExportTrailer(p.node)) p.remove();
         },

         // Explode `const Tools = { ... }` into hoisted, exported declarations.
         VariableDeclarator(p) {
            if (toolsProcessed) return;
            if (!t.isIdentifier(p.node.id, { name: 'Tools' })) return;
            if (!t.isObjectExpression(p.node.init)) return;
            toolsProcessed = true;

            const hoisted = []; // statements inserted before `const Tools`
            const assembled = []; // shorthand props for the rebuilt object

            for (const prop of p.node.init.properties) {
               // `_modules,` -> reference the existing top-level binding, don't redeclare.
               if (
                  t.isObjectProperty(prop) &&
                  prop.shorthand &&
                  t.isIdentifier(prop.key) &&
                  t.isIdentifier(prop.value, { name: prop.key.name })
               ) {
                  memberNames.add(prop.key.name);
                  assembled.push(shorthand(prop.key.name));
                  continue;
               }

               // `name(args) { ... }` -> `export function name(args) { ... }`
               if (t.isObjectMethod(prop) && prop.kind === 'method' && t.isIdentifier(prop.key)) {
                  const name = prop.key.name;
                  memberNames.add(name);
                  const fn = t.functionDeclaration(
                     t.identifier(name),
                     prop.params,
                     prop.body,
                     prop.generator,
                     prop.async
                  );
                  hoisted.push(exportIfPublic(name, fn));
                  assembled.push(shorthand(name));
                  continue;
               }

               // `name: <value>` -> `export const name = <value>;`
               if (t.isObjectProperty(prop) && !prop.computed && t.isIdentifier(prop.key)) {
                  const name = prop.key.name;
                  memberNames.add(name);
                  const decl = t.variableDeclaration('const', [
                     t.variableDeclarator(t.identifier(name), prop.value),
                  ]);
                  hoisted.push(exportIfPublic(name, decl));
                  assembled.push(shorthand(name));
                  continue;
               }

               // Anything not hoistable (getter/setter/spread/computed): fail loudly
               // instead of silently dropping a member. None exist today.
               throw new Error(
                  `transform-tools: unsupported Tools member shape at line ${
                     prop.loc?.start.line ?? '?'
                  }; update the transform to handle it.`
               );
            }

            p.node.init = t.objectExpression(assembled);
            p.parentPath.insertBefore(hoisted);
         },

         Program: {
            exit(p) {
               // Rewrite every `Tools.<member>` member access to a bare `<member>`.
               p.traverse({
                  MemberExpression(mp) {
                     const n = mp.node;
                     if (
                        !n.computed &&
                        t.isIdentifier(n.object, { name: 'Tools' }) &&
                        t.isIdentifier(n.property) &&
                        memberNames.has(n.property.name)
                     ) {
                        mp.replaceWith(t.identifier(n.property.name));
                     }
                  },
               });

               // import { createRequire } from 'module';
               const importCreateRequire = t.importDeclaration(
                  [t.importSpecifier(t.identifier('createRequire'), t.identifier('createRequire'))],
                  t.stringLiteral('module')
               );
               // const require = createRequire(import.meta.url);
               const requireShim = t.variableDeclaration('const', [
                  t.variableDeclarator(
                     t.identifier('require'),
                     t.callExpression(t.identifier('createRequire'), [
                        t.memberExpression(
                           t.metaProperty(t.identifier('import'), t.identifier('meta')),
                           t.identifier('url')
                        ),
                     ])
                  ),
               ]);
               p.unshiftContainer('body', requireShim);
               p.unshiftContainer('body', importCreateRequire);

               // Back-compat default export; dead-code-eliminated when unused.
               p.pushContainer('body', t.exportDefaultDeclaration(t.identifier('Tools')));
            },
         },
      },
   };
};

export async function run() {
   try {
      const code = await fs.readFile(inputFile, 'utf8');
      const result = await transformAsync(code, {
         plugins: [transformToolsToTreeShakeable],
         parserOpts: {
            plugins: ['classProperties', 'classPrivateProperties', 'classPrivateMethods', 'privateIn'],
         },
         configFile: false,
         babelrc: false,
         generatorOpts: {
            compact: false,
         },
      });

      await fs.mkdir(path.dirname(outputFile), { recursive: true });
      await fs.writeFile(outputFile, result.code);
      console.log(`Successfully transformed Tools.js to tree-shakeable ESM at ${outputFile}`);
   } catch (err) {
      console.error('Error transforming Tools.js:', err);
      process.exit(1);
   }
}

if (process.argv[1] && path.resolve(process.argv[1]) === __filename) {
   run();
}
