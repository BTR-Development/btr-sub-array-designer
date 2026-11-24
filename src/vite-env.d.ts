/// <reference types="vite/client" />

declare module '*.dbpr?url' {
  const url: string;
  export default url;
}

interface ImportMetaEnv {
  /** Soundvision .xmlc key and IV, 32 and 16 ASCII characters; never committed (see io/vendor/soundvision/xmlcCodec.ts). */
  readonly VITE_SV_XMLC_KEY?: string;
  readonly VITE_SV_XMLC_IV?: string;
}
