import * as v from 'valibot';
import type { TokenTableColumns } from './client';

export const dateLikeSchema = v.union([v.date(), v.string(), v.number()]);
export const ipAddressListSchema = v.array(v.string());
export const ipAddressesSchema = v.union([ipAddressListSchema, v.string(), v.null()]);

export const tokenRecordRawSchema = v.object({
  uid: v.string(),
  tokenHash: v.string(),
  tokenSalt: v.string(),
  expiresAt: dateLikeSchema,
  createdAt: dateLikeSchema,
  lastUsedAt: v.optional(v.union([dateLikeSchema, v.null()])),
  ipAddresses: v.optional(ipAddressesSchema),
  initToken: v.optional(v.union([v.boolean(), v.number(), v.null()])),
});

export type TokenRecordRaw = v.InferOutput<typeof tokenRecordRawSchema>;
export type DateLike = v.InferOutput<typeof dateLikeSchema>;
export type IpAddressesLike = v.InferOutput<typeof ipAddressesSchema>;

export type TokenRecordInput = {
  uid: string;
  tokenHash: string;
  tokenSalt: string;
  expiresAt: Date | string | number;
  createdAt: Date | string | number;
  lastUsedAt?: Date | string | number | null;
  ipAddresses?: string[] | string | null;
  initToken?: boolean | number | null;
};

export type SelectFromLike = {
  from(table: TokenTableColumns): Promise<TokenRecordInput[]>;
};

export type SelectableDbLike = {
  select(fields: TokenTableColumns): SelectFromLike;
};
