import fs from 'node:fs';
let source = fs.readFileSync('Dockerfile.multi', 'utf8');
const sdk =
  'COPY --from=agents_sdk /dist /app/node_modules/@librechat/agents/dist\nCOPY --from=agents_sdk /package.json /app/node_modules/@librechat/agents/package.json\n';
source = source.replace(
  '# Build `data-provider` package',
  sdk + '\n# Build `data-provider` package',
);
source = source.replace('COPY api ./api', sdk + '\nCOPY api ./api');
fs.writeFileSync('Dockerfile.ja.generated', source);
