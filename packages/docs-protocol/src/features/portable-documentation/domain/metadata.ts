export type DocumentJsonValue = boolean | null | number | string | readonly DocumentJsonValue[] | { readonly [key: string]: DocumentJsonValue };
export interface DocumentMetadataObject { readonly [key: string]: DocumentJsonValue }
