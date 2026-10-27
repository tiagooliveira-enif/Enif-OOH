/* Verifica a estrutura da página: um só bloco <style>, chavetas equilibradas e nenhum CSS solto fora dele. */
const fs = require('fs'), assert = require('assert');
for (const f of ['public/app/index.html', 'public/player/index.html']) {
  const s = fs.readFileSync(f, 'utf8');
  const sem = s.replace(/<script[\s\S]*?<\/script>/g, '');
  const blocos = sem.match(/<style[\s\S]*?<\/style>/g) || [];
  assert.ok(blocos.length <= 1, f + ': mais de um bloco <style> (CSS pode ficar como texto)');
  const css = blocos.join('');
  assert.strictEqual(css.split('{').length, css.split('}').length, f + ': chavetas do CSS desequilibradas');
  const fora = sem.replace(/<style[\s\S]*?<\/style>/g, '');
  assert.ok(!/@media|\n\s*\.[\w-]+\s*\{/.test(fora), f + ': CSS fora do bloco <style>');
  console.log('PASS estrutura da página ' + f);
}
