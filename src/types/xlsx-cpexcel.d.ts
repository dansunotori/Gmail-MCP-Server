// SheetJS ships its codepage tables as an untyped module; set_cptable takes the module itself.
declare module 'xlsx/dist/cpexcel.full.mjs' {
  export const version: string;
  export const cptable: unknown;
  export const utils: unknown;
}
