export function uint8ArrayToBase64(uint8Array: Uint8Array): string {
  return Buffer.from(uint8Array).toString('base64');
}
