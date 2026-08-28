import type { Rule } from 'eslint';

/**
 * Discourages multiline string array literals joined with a newline.
 */
const preferLitedent: Rule.RuleModule = {
   meta: {
      type: 'suggestion',
      docs: {
         description:
            "Prefer litedent for long multiline text instead of string arrays joined with '\\n'.",
      },
      messages: {
         preferLitedent:
            "Use litedent for multiline text instead of joining a string array with '\\n'.",
      },
      schema: [],
   },
   create(context) {
      return {
         CallExpression(node) {
            if (
               node.callee.type !== 'MemberExpression' ||
               node.callee.computed ||
               node.callee.property.type !== 'Identifier' ||
               node.callee.property.name !== 'join' ||
               node.callee.object.type !== 'ArrayExpression' ||
               node.callee.object.loc?.start.line === node.callee.object.loc?.end.line ||
               node.arguments.length !== 1 ||
               node.arguments[0].type !== 'Literal' ||
               node.arguments[0].value !== '\n' ||
               !node.callee.object.elements.every(
                  (element) =>
                     (element?.type === 'Literal' && typeof element.value === 'string') ||
                     element?.type === 'TemplateLiteral'
               )
            ) {
               return;
            }

            context.report({ node, messageId: 'preferLitedent' });
         },
      };
   },
};

export default preferLitedent;
