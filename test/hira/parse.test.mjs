// node --test  (Node 20 내장 러너, 무의존성)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseHiraResponse, isNormalResult, isTransientResult } from '../../lib/hira/parse.js';
import * as RAW from './fixtures/raw.mjs';

const fx = (name) =>
  readFileSync(fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url)), 'utf8');

test('1. 정상 JSON 파싱 — 목록 배열', () => {
  const p = parseHiraResponse(fx('hospBasisList_clCd28.json'));
  assert.equal(p.format, 'json');
  assert.equal(p.gatewayError, false);
  assert.equal(p.resultCode, '00');
  assert.equal(p.totalCount, 1280);
  assert.equal(p.items.length, 5);
  assert.equal(p.items[0].ykiho, 'JDQ4MTYyMiM4MSMkMSMkNCMkOTkkNTgxMzUxIzIxIyQxIyQ1IyQ4OSQzNjE4MzIjNjEjJDEjJDAjJDgz');
  assert.ok(isNormalResult(p));
});

test('2a. JSON item 단건 → 배열 1개로 정규화', () => {
  const p = parseHiraResponse(fx('hospBasisList_one.json'));
  assert.equal(p.items.length, 1);
  assert.equal(p.items[0].yadmNm, '(의)밀성학원의료재단 성모아하브요양병원');
});

test('2b. XML item 단건 / 배열 모두 처리', () => {
  const one = parseHiraResponse(RAW.XML_NORMAL_ONE);
  assert.equal(one.format, 'xml');
  assert.equal(one.items.length, 1);
  assert.equal(one.items[0].ykiho, 'YKIHO_XML_ONE');

  const list = parseHiraResponse(RAW.XML_NORMAL_LIST);
  assert.equal(list.items.length, 2);
  assert.equal(list.totalCount, 2);
  assert.equal(list.items[0].XPos, '126.977');
});

test('2c. 결과 0건 (item 없음)', () => {
  const p = parseHiraResponse(RAW.JSON_EMPTY);
  assert.equal(p.items.length, 0);
  assert.equal(p.totalCount, 0);
  assert.ok(isNormalResult(p));
});

test('3. resultCode / resultMsg 오류 처리', () => {
  const param = parseHiraResponse(RAW.JSON_PARAM_ERROR);
  assert.equal(param.gatewayError, false);
  assert.equal(param.resultCode, '30');
  assert.equal(isNormalResult(param), false);
  assert.equal(isTransientResult(param), false); // 비일시적 → 재시도 안 함

  const gw12json = parseHiraResponse(RAW.JSON_GATEWAY_12);
  assert.equal(gw12json.gatewayError, true);
  assert.equal(gw12json.resultCode, '12');
  assert.ok(isTransientResult(gw12json)); // 일시적 → 재시도

  const gw12xml = parseHiraResponse(RAW.XML_GATEWAY_12);
  assert.equal(gw12xml.format, 'xml');
  assert.equal(gw12xml.gatewayError, true);
  assert.equal(gw12xml.resultCode, '12');
  assert.ok(isTransientResult(gw12xml));

  const gw22 = parseHiraResponse(RAW.JSON_GATEWAY_22);
  assert.equal(gw22.gatewayError, true);
  assert.equal(gw22.resultCode, '22');
  assert.equal(isTransientResult(gw22), false); // 일일한도 초과는 재시도 대상 아님
});

test('3b. 완전 쓰레기 입력도 throw 하지 않음', () => {
  const p = parseHiraResponse('<<not xml not json>>');
  assert.equal(p.items.length, 0);
  assert.equal(isNormalResult(p), false);
});

test('scrubFn 훅 적용', () => {
  const dirty = JSON.stringify({ response: { header: { resultCode: '00' }, body: { items: { item: [{ note: 'KEYKEYKEY' }] } } } });
  const p = parseHiraResponse(dirty, (s) => s.split('KEYKEYKEY').join('***'));
  assert.equal(p.items[0].note, '***');
});
