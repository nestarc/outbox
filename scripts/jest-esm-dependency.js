// Nest 12 ships ESM JavaScript, including import.meta.url for createRequire.
// Keep its original module URL while compiling it for Jest 29's CommonJS VM.
// This transformer is used only by tests, never by the package build.
const ts = require('typescript');
const { pathToFileURL } = require('node:url');
const { createHash } = require('node:crypto');
const { readFileSync } = require('node:fs');
const transformerSource = readFileSync(__filename, 'utf8');

module.exports = {
  getCacheKey(sourceText, sourcePath, options) {
    return createHash('sha256')
      .update(
        JSON.stringify([
          transformerSource,
          ts.version,
          sourceText,
          sourcePath,
          options.configString,
          options.instrument,
        ]),
      )
      .digest('hex');
  },
  process(sourceText, sourcePath) {
    const output = ts.transpileModule(sourceText, {
      fileName: sourcePath,
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2022,
        esModuleInterop: true,
        sourceMap: true,
        inlineSources: true,
      },
      transformers: {
        before: [
          (context) => (sourceFile) => {
            function visit(node) {
              if (
                ts.isPropertyAccessExpression(node) &&
                ts.isMetaProperty(node.expression) &&
                node.expression.keywordToken === ts.SyntaxKind.ImportKeyword &&
                node.expression.name.text === 'meta' &&
                node.name.text === 'url'
              ) {
                return ts.factory.createStringLiteral(
                  pathToFileURL(sourcePath).href,
                );
              }
              return ts.visitEachChild(node, visit, context);
            }
            return ts.visitNode(sourceFile, visit);
          },
        ],
      },
    });
    return { code: output.outputText, map: output.sourceMapText };
  },
};
