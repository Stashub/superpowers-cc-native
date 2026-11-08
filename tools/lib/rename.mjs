import { PLUGIN_NAME } from './constants.mjs';

export const OLD_REF_SOURCE = '(?<![\\w-])superpowers:(?=[a-z])';

const newRegex = () => new RegExp(OLD_REF_SOURCE, 'g');

export function isText(buf) {
  return !buf.includes(0x00);
}

export function renameBuffer(buf) {
  let count = 0;
  const text = buf.toString('latin1').replace(newRegex(), () => {
    count += 1;
    return `${PLUGIN_NAME}:`;
  });
  return { buf: Buffer.from(text, 'latin1'), count };
}

export function countOldRefs(buf) {
  return (buf.toString('latin1').match(newRegex()) ?? []).length;
}
