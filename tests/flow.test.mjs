import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateFlow } from '../server/scripts/store.js';

const base = () => ({ version: 1, nodes: [{ id: 'n1', type: 'trigger' }], edges: [] });

test('validateFlow：合法流程通过', () => {
  assert.equal(validateFlow(base()), null);
});

test('validateFlow：五种节点类型都接受（含播报 announce）', () => {
  const f = { nodes: ['trigger', 'condition', 'delay', 'action', 'announce'].map((type, i) => ({ id: 'n' + i, type })), edges: [] };
  assert.equal(validateFlow(f), null);
});

test('validateFlow：播报节点接入主链可通过', () => {
  const f = {
    nodes: [
      { id: 'n_start', type: 'trigger' },
      { id: 'n_eval', type: 'condition' },
      { id: 'n_announce', type: 'announce', label: '播报：热水器开起啦，主人' },
      { id: 'n_act', type: 'action' },
    ],
    edges: [
      { from: 'n_start', to: 'n_eval' },
      { from: 'n_eval', to: 'n_announce' },
      { from: 'n_announce', to: 'n_act' },
    ],
  };
  assert.equal(validateFlow(f), null);
});

test('validateFlow：未知节点类型被拒', () => {
  assert.match(validateFlow({ nodes: [{ id: 'a', type: 'foo' }], edges: [] }), /未知节点类型/);
});

test('validateFlow：重复 id 被拒', () => {
  assert.match(validateFlow({ nodes: [{ id: 'a', type: 'trigger' }, { id: 'a', type: 'action' }], edges: [] }), /重复/);
});

test('validateFlow：边指向不存在节点被拒', () => {
  assert.match(validateFlow({ nodes: [{ id: 'a', type: 'trigger' }], edges: [{ from: 'a', to: 'ghost' }] }), /不存在/);
});

test('validateFlow：缺 nodes/edges 被拒', () => {
  assert.match(validateFlow({ version: 1 }), /nodes \/ edges/);
});
