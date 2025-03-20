declare module 'jsesc';
declare module 'strip-ansi';

interface CustomMatchers<R = unknown> {
  toHaveBeenCalledNormalized(expected: string): R;
}

declare global {
  namespace Vi {
    interface Assertion extends CustomMatchers {}

    interface AsymmetricMatchersContaining extends CustomMatchers {}
  }
}
