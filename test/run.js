'use strict';

// Dependency-free test runner. Usage: npm test  (or: node test/run.js)

function makeT() {
  const st = { pass: 0, fail: 0, failures: [] };
  return {
    st,
    eq(actual, expected, msg) {
      if (JSON.stringify(actual) === JSON.stringify(expected)) st.pass++;
      else { st.fail++; st.failures.push(`${msg} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`); }
    },
    ok(cond, msg) { if (cond) st.pass++; else { st.fail++; st.failures.push(msg); } },
  };
}

const suites = ['parseAlert', 'classifyPriority', 'dedupe', 'enrich', 'formatMessage', 'coverage'];

let totalPass = 0, totalFail = 0;
console.log('noc-bot — tests\n');
for (const name of suites) {
  const t = makeT();
  try {
    require('./' + name + '.test.js')(t);
  } catch (e) {
    t.st.fail++; t.st.failures.push('EXCEPTION: ' + ((e && e.stack) || e));
  }
  console.log(`${t.st.fail ? '✗' : '✓'} ${name}: ${t.st.pass} ok, ${t.st.fail} failed`);
  t.st.failures.forEach((f) => console.log('    ' + f));
  totalPass += t.st.pass; totalFail += t.st.fail;
}
console.log(`\nTOTAL: ${totalPass}/${totalPass + totalFail} ok` + (totalFail ? `  (${totalFail} failed)` : '  ✓'));
process.exit(totalFail ? 1 : 0);
