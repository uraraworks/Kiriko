// 走行中はロードノイズが途切れないので、whisper が「何も言っていない所」に
// それらしい文を作ってしまう。実素材と照合して見つけた特徴で落とす。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const { hallucinationReason, isRepetitive } = createRequire(import.meta.url)('../../mcp/transcribe.js');

const seg = (from, to, text) => ({ from, to, text });

test('窓いっぱいの区間は幻聴として落とす', () => {
  // whisper の窓は 30 秒。そこに 1 文だけ、は「発話が見つからなかった」の印
  assert.equal(hallucinationReason(seg(0, 30, 'ご視聴ありがとうございました')), 'window');
  assert.equal(hallucinationReason(seg(0, 29.7, '車椅子を切り替えます。')), 'window');
  // ふつうの長さなら残す
  assert.equal(hallucinationReason(seg(0, 12, 'ようやく一軒目が上がりました')), null);
});

test('学習データ由来の決まり文句を落とす', () => {
  for (const t of ['ご視聴ありがとうございました', 'おやすみなさい。', 'お疲れ様でした']) {
    assert.equal(hallucinationReason(seg(0, 5, t)), 'phrase', t);
  }
});

test('同じ語の繰り返しを落とす', () => {
  assert.equal(hallucinationReason(seg(0, 7, '東京都交通地は、東京都交通地は、東京都交通地を通過します。')), 'repeat');
  assert.equal(hallucinationReason(seg(0, 6, 'スタッファンのスタッファンのスタッファンのスタッファンを取り出します')), 'repeat');
});

test('ふつうのセリフは落とさない', () => {
  const ok = [
    '本日の結果ですが稼働時間1時間31分売上はクエスト込みで2529円5件ですね',
    'さあ、時間も徐々に終わりの時間に近づいてきたので、一旦、住吉の方に戻ります。',
    'スタバのショート案件をいただきました',
    'ピックアップしました。次はマグロですが、すぐそこですね。',
    'さあ、5軒行けるのか',
    'はい',
  ];
  for (const t of ok) assert.equal(hallucinationReason(seg(0, 8, t)), null, t);
});

test('繰り返しの判定は、ふつうの言い回しを巻き込まない', () => {
  assert.equal(isRepetitive('今日はこれで東に流されることが確定しました'), false);
  assert.equal(isRepetitive('ありがとうございます、ありがとうございます、ありがとうございます'), true);
});
