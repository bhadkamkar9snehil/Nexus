import {test} from 'node:test';
import assert from 'node:assert/strict';
import {quantile} from '../../monitor-ui/data.js';
test('monitor percentiles use sorted samples and interpolate the median and upper tail',()=>{
 assert.equal(quantile([],0.5),null);
 assert.equal(quantile([10],0.95),10);
 assert.equal(quantile([9,1,5],0.5),5);
 assert.equal(quantile([1,9],0.5),5);
 assert.ok(Math.abs(quantile([1,9],0.95)!-8.6)<0.00001);
 const source=[9,1,5];quantile(source,0.95);assert.deepEqual(source,[9,1,5]);
});
