import 'dotenv/config';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { z } from 'zod';

const DEFAULT_PUBLIC_STORE_URL = 'https://www.ctwtech.store';
const DEFAULT_CANONICAL_STORE_URL = 'https://ctwtech.store';
const PAGE_LIMIT = 250;
const COLLECTION_CONCURRENCY = 5;
const UPSERT_BATCH_SIZE = 50;

const publicSyncEnvSchema = z.object({
  SUPABASE_URL: z.string().url('SUPABASE_URL must be a valid URL'),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1, 'SUPABASE_SERVICE_ROLE_KEY is required'),
  PUBLIC_STORE_URL: z.string().url().optional(),
  CANONICAL_STORE_URL: z.string().url().optional(),
});

interface StorefrontVariant {
  id: number;
  title: string;
  option1: string | null;
  option2: string | null;
  option3: string | null;
  sku: string | null;
  available: boolean;
  price: string;
  compare_at_price: string | null;
  position: number;
  updated_at?: string;
}

interface StorefrontImage {
  id: number;
  src: string;
  position: number;
}

interface StorefrontOption {
  name: string;
  position: number;
  values: string[];
}

interface StorefrontProduct {
  id: number;
  title: string;
  handle: string;
  body_html: string | null;
  published_at: string | null;
  created_at: string;
  updated_at: string;
  vendor: string;
  product_type: string;
  tags: string[] | string;
  variants: StorefrontVariant[];
  images: StorefrontImage[];
  options: StorefrontOption[];
}

interface StorefrontCollection {
  id: number;
  title: string;
  handle: string;
  description: string | null;
  products_count: number;
}

interface StorefrontPage {
  id: number;
  title: string;
  handle: string;
  body_html: string | null;
  published_at: string | null;
  updated_at?: string;
}

export interface CatalogExportRecord {
  shopifyProductId: string;
  numericId: number;
  handle: string;
  title: string;
  vendor: string | null;
  productType: string | null;
  collections: string[];
  tags: string[];
  currency: string;
  priceMin: number | null;
  priceMax: number | null;
  availableOnline: boolean;
  variantCount: number;
  productUrl: string;
  imageUrl: string | null;
  description: string | null;
  updatedAt: string;
  variants: Array<{
    shopifyVariantId: string;
    numericId: number;
    title: string;
    sku: string | null;
    price: number | null;
    compareAtPrice: number | null;
    availableOnline: boolean;
    position: number;
  }>;
}

export interface PublicSyncSummary {
  storeUrl: string;
  canonicalUrl: string;
  products: number;
  variants: number;
  collections: number;
  pages: number;
  dataQualityIssues: number;
  jsonExportPath: string;
  csvExportPath: string;
}

function getSupabaseClient(): {
  supabase: SupabaseClient;
  storeUrl: string;
  canonicalUrl: string;
} {
  const parsed = publicSyncEnvSchema.safeParse(process.env);
  if (!parsed.success) {
    throw new Error(
      `Invalid environment variables for public sync: ${JSON.stringify(parsed.error.flatten().fieldErrors)}`
    );
  }

  const supabase = createClient(parsed.data.SUPABASE_URL, parsed.data.SUPABASE_SERVICE_ROLE_KEY, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
    },
  });

  const storeUrl = (parsed.data.PUBLIC_STORE_URL ?? DEFAULT_PUBLIC_STORE_URL).replace(/\/+$/, '');
  const canonicalUrl = (parsed.data.CANONICAL_STORE_URL ?? DEFAULT_CANONICAL_STORE_URL).replace(/\/+$/, '');

  return { supabase, storeUrl, canonicalUrl };
}

function decodeHtmlEntities(input: string): string {
  return input
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&#(\d+);/g, (_, code) => {
      const n = Number(code);
      return Number.isFinite(n) ? String.fromCharCode(n) : '';
    });
}

function stripHtml(html: string | null | undefined): string | null {
  if (!html) return null;
  const cleaned = decodeHtmlEntities(
    html
      .replace(/<!--[\s\S]*?-->/g, ' ')
      .replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, ' ')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/(p|div|li|h[1-6]|tr)>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
  )
    .replace(/\s+/g, ' ')
    .trim();

  return cleaned || null;
}

function normalizeTags(rawTags: string[] | string | undefined): string[] {
  if (Array.isArray(rawTags)) {
    return rawTags.map((t) => String(t).trim()).filter(Boolean);
  }
  if (typeof rawTags === 'string') {
    return rawTags
      .split(',')
      .map((t) => t.trim())
      .filter(Boolean);
  }
  return [];
}

async function fetchJson<T>(url: string): Promise<T> {
  const res = await fetch(url, {
    headers: {
      Accept: 'application/json',
      'User-Agent': 'CTW-WhatsApp-Bot-Catalog-Sync/1.0',
    },
  });

  if (!res.ok) {
    throw new Error(`HTTP ${res.status} fetching ${url}`);
  }

  return (await res.json()) as T;
}

async function fetchAllProducts(storeUrl: string): Promise<StorefrontProduct[]> {
  const products: StorefrontProduct[] = [];
  let page = 1;

  while (true) {
    const data = await fetchJson<{ products?: StorefrontProduct[] }>(
      `${storeUrl}/products.json?limit=${PAGE_LIMIT}&page=${page}`
    );
    const batch = data.products ?? [];
    if (batch.length === 0) break;
    products.push(...batch);
    if (batch.length < PAGE_LIMIT) break;
    page++;
  }

  return products;
}

async function fetchAllCollections(storeUrl: string): Promise<StorefrontCollection[]> {
  const collections: StorefrontCollection[] = [];
  let page = 1;

  while (true) {
    const data = await fetchJson<{ collections?: StorefrontCollection[] }>(
      `${storeUrl}/collections.json?limit=${PAGE_LIMIT}&page=${page}`
    );
    const batch = data.collections ?? [];
    if (batch.length === 0) break;
    collections.push(...batch);
    if (batch.length < PAGE_LIMIT) break;
    page++;
  }

  return collections;
}

async function buildProductCollectionsMap(
  storeUrl: string,
  collections: StorefrontCollection[]
): Promise<Map<number, string[]>> {
  const map = new Map<number, Set<string>>();
  const nonEmpty = collections.filter((c) => c.products_count > 0);

  for (let i = 0; i < nonEmpty.length; i += COLLECTION_CONCURRENCY) {
    const chunk = nonEmpty.slice(i, i + COLLECTION_CONCURRENCY);
    await Promise.all(
      chunk.map(async (col) => {
        let page = 1;
        while (true) {
          const data = await fetchJson<{ products?: Array<{ id: number }> }>(
            `${storeUrl}/collections/${encodeURIComponent(col.handle)}/products.json?limit=${PAGE_LIMIT}&page=${page}`
          );
          const batch = data.products ?? [];
          if (batch.length === 0) break;

          for (const p of batch) {
            let set = map.get(p.id);
            if (!set) {
              set = new Set<string>();
              map.set(p.id, set);
            }
            set.add(col.title);
          }

          if (batch.length < PAGE_LIMIT) break;
          page++;
        }
      })
    );
  }

  const result = new Map<number, string[]>();
  for (const [productId, titles] of map.entries()) {
    result.set(productId, [...titles].sort());
  }
  return result;
}

async function fetchAllPages(storeUrl: string): Promise<StorefrontPage[]> {
  const pages: StorefrontPage[] = [];
  let page = 1;

  while (true) {
    const data = await fetchJson<{ pages?: StorefrontPage[] }>(
      `${storeUrl}/pages.json?limit=${PAGE_LIMIT}&page=${page}`
    );
    const batch = data.pages ?? [];
    if (batch.length === 0) break;
    pages.push(...batch);
    if (batch.length < PAGE_LIMIT) break;
    page++;
  }

  return pages;
}

function escapeCsvCell(value: unknown): string {
  const str = value === null || value === undefined ? '' : String(value);
  if (/[",\r\n]/.test(str)) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

function buildCsv(records: CatalogExportRecord[]): string {
  const headers = [
    'shopify_product_id',
    'numeric_id',
    'handle',
    'title',
    'vendor',
    'product_type',
    'collections',
    'tags',
    'currency',
    'price_min',
    'price_max',
    'available_online',
    'variant_count',
    'product_url',
    'image_url',
    'description',
    'updated_at',
  ];

  const rows = records.map((r) =>
    [
      r.shopifyProductId,
      r.numericId,
      r.handle,
      r.title,
      r.vendor ?? '',
      r.productType ?? '',
      r.collections.join(' | '),
      r.tags.join(' | '),
      r.currency,
      r.priceMin ?? '',
      r.priceMax ?? '',
      r.availableOnline,
      r.variantCount,
      r.productUrl,
      r.imageUrl ?? '',
      r.description ?? '',
      r.updatedAt,
    ]
      .map(escapeCsvCell)
      .join(',')
  );

  return [headers.join(','), ...rows].join('\n');
}

export async function runPublicStoreSync(): Promise<PublicSyncSummary> {
  const { supabase, storeUrl, canonicalUrl } = getSupabaseClient();
  const currency = 'GYD';

  console.log(`🔄 Starting public storefront sync from ${storeUrl}...`);

  const [products, collections, pages] = await Promise.all([
    fetchAllProducts(storeUrl),
    fetchAllCollections(storeUrl),
    fetchAllPages(storeUrl),
  ]);

  console.log(
    `  ✓ Fetched ${products.length} products, ${collections.length} collections, ${pages.length} pages`
  );

  const productCollections = await buildProductCollectionsMap(storeUrl, collections);
  console.log(`  ✓ Mapped collections for ${productCollections.size} products`);

  let productCount = 0;
  let variantCount = 0;
  let issueCount = 0;
  const exportRecords: CatalogExportRecord[] = [];
  const syncedAt = new Date().toISOString();

  const prepared = products.map((p) => {
    const shopifyProductId = `gid://shopify/Product/${p.id}`;
    const productUrl = `${canonicalUrl}/products/${p.handle}`;
    const description = stripHtml(p.body_html);
    const collectionNames = productCollections.get(p.id) ?? [];
    const tags = normalizeTags(p.tags);

    const parsedPrices = (p.variants ?? [])
      .map((v) => Number(v.price))
      .filter((n) => Number.isFinite(n));
    const priceMin = parsedPrices.length > 0 ? Math.min(...parsedPrices) : null;
    const priceMax = parsedPrices.length > 0 ? Math.max(...parsedPrices) : null;
    const availableOnline = (p.variants ?? []).some((v) => Boolean(v.available));

    const metafields = {
      source: 'public_storefront_json',
      collections: collectionNames,
      available_online: availableOnline,
      options: p.options ?? [],
    };

    const productRow = {
      shopify_id: shopifyProductId,
      handle: p.handle,
      title: p.title,
      vendor: p.vendor?.trim() || null,
      product_type: p.product_type?.trim() || null,
      tags,
      description,
      status: 'ACTIVE',
      is_published: true,
      url: productUrl,
      image_url: p.images?.[0]?.src ?? null,
      metafields,
      price_min: priceMin,
      price_max: priceMax,
      currency,
      shopify_updated_at: p.updated_at,
      synced_at: syncedAt,
    };

    const variants = (p.variants ?? []).map((v) => {
      const vPrice = Number(v.price);
      const vCompare = v.compare_at_price ? Number(v.compare_at_price) : null;
      return {
        shopify_id: `gid://shopify/ProductVariant/${v.id}`,
        title: v.title,
        sku: v.sku?.trim() || null,
        barcode: null,
        price: Number.isFinite(vPrice) ? vPrice : null,
        compare_at_price: vCompare !== null && Number.isFinite(vCompare) ? vCompare : null,
        inventory_item_id: null,
        inventory_tracked: false,
        position: v.position,
      };
    });

    exportRecords.push({
      shopifyProductId,
      numericId: p.id,
      handle: p.handle,
      title: p.title,
      vendor: p.vendor?.trim() || null,
      productType: p.product_type?.trim() || null,
      collections: collectionNames,
      tags,
      currency,
      priceMin,
      priceMax,
      availableOnline,
      variantCount: variants.length,
      productUrl,
      imageUrl: p.images?.[0]?.src ?? null,
      description,
      updatedAt: p.updated_at,
      variants: (p.variants ?? []).map((v) => {
        const vPrice = Number(v.price);
        const vCompare = v.compare_at_price ? Number(v.compare_at_price) : null;
        return {
          shopifyVariantId: `gid://shopify/ProductVariant/${v.id}`,
          numericId: v.id,
          title: v.title,
          sku: v.sku?.trim() || null,
          price: Number.isFinite(vPrice) ? vPrice : null,
          compareAtPrice: vCompare !== null && Number.isFinite(vCompare) ? vCompare : null,
          availableOnline: Boolean(v.available),
          position: v.position,
        };
      }),
    });

    return { raw: p, productRow, priceMin, variants };
  });

  for (let i = 0; i < prepared.length; i += UPSERT_BATCH_SIZE) {
    const batch = prepared.slice(i, i + UPSERT_BATCH_SIZE);
    const { data: upsertedProducts, error: prodErr } = await supabase
      .from('products')
      .upsert(
        batch.map((item) => item.productRow),
        { onConflict: 'shopify_id' }
      )
      .select('id, shopify_id');

    if (prodErr) {
      throw new Error(`Product batch upsert failed (offset ${i}): ${prodErr.message}`);
    }

    const dbIdByShopifyId = new Map<string, string>();
    for (const row of upsertedProducts ?? []) {
      dbIdByShopifyId.set(row.shopify_id, row.id);
    }
    productCount += upsertedProducts?.length ?? 0;

    const batchDbIds: string[] = [];
    const variantRows: Array<Record<string, unknown>> = [];
    const issueRows: Array<{ product_id: string; issue_type: string; details: string }> = [];

    for (const item of batch) {
      const dbProductId = dbIdByShopifyId.get(item.productRow.shopify_id);
      if (!dbProductId) continue;
      batchDbIds.push(dbProductId);

      for (const v of item.variants) {
        variantRows.push({ ...v, product_id: dbProductId });
      }

      if (item.raw.handle.endsWith('-copy') || /-copy-\d+$/.test(item.raw.handle)) {
        issueRows.push({
          product_id: dbProductId,
          issue_type: 'duplicate_copy',
          details: `Handle ends with copy pattern: ${item.raw.handle}`,
        });
      }
      if (item.priceMin === null || !Number.isFinite(item.priceMin) || item.priceMin === 0) {
        issueRows.push({
          product_id: dbProductId,
          issue_type: item.priceMin === 0 ? 'price_zero' : 'missing_price',
          details: `Product "${item.raw.title}" has min price ${item.priceMin}`,
        });
      }
    }

    if (batchDbIds.length > 0) {
      const { error: delIssueErr } = await supabase
        .from('data_quality_issues')
        .delete()
        .in('product_id', batchDbIds)
        .eq('resolved', false);
      if (delIssueErr) {
        throw new Error(`Data quality cleanup failed (offset ${i}): ${delIssueErr.message}`);
      }
    }

    if (variantRows.length > 0) {
      const incomingShopifyIds = variantRows
        .map((v) => String(v.shopify_id ?? ""))
        .filter(Boolean);

      const existingVariantMeta = new Map<
        string,
        { barcode: string | null; inventory_item_id: string | null; inventory_tracked: boolean }
      >();

      if (incomingShopifyIds.length > 0) {
        const { data: existingVars, error: fetchVarErr } = await supabase
          .from('product_variants')
          .select('shopify_id, barcode, inventory_item_id, inventory_tracked')
          .in('shopify_id', incomingShopifyIds);

        if (fetchVarErr) {
          throw new Error(`Existing variant lookup failed (offset ${i}): ${fetchVarErr.message}`);
        }

        for (const row of existingVars ?? []) {
          existingVariantMeta.set(String(row.shopify_id), {
            barcode: row.barcode ?? null,
            inventory_item_id: row.inventory_item_id ?? null,
            inventory_tracked: Boolean(row.inventory_tracked),
          });
        }
      }

      const mergedVariantRows = variantRows.map((v) => {
        const prev = existingVariantMeta.get(String(v.shopify_id));
        if (!prev) return v;
        return {
          ...v,
          barcode: v.barcode ?? prev.barcode,
          inventory_item_id: v.inventory_item_id ?? prev.inventory_item_id,
          inventory_tracked: Boolean(v.inventory_tracked) || prev.inventory_tracked,
        };
      });

      const { error: varErr } = await supabase
        .from('product_variants')
        .upsert(mergedVariantRows, { onConflict: 'shopify_id' });
      if (varErr) {
        throw new Error(`Variant batch upsert failed (offset ${i}): ${varErr.message}`);
      }
      variantCount += mergedVariantRows.length;
    }

    if (issueRows.length > 0) {
      const { error: issueErr } = await supabase.from('data_quality_issues').insert(issueRows);
      if (issueErr) {
        throw new Error(`Data quality batch insert failed (offset ${i}): ${issueErr.message}`);
      }
      issueCount += issueRows.length;
    }
  }

  let pageCount = 0;
  if (pages.length > 0) {
    const pageRows = pages.map((page) => ({
      shopify_id: `gid://shopify/Page/${page.id}`,
      handle: page.handle,
      title: page.title,
      body: stripHtml(page.body_html),
      url: `${canonicalUrl}/pages/${page.handle}`,
      synced_at: syncedAt,
    }));

    const { error: pageErr } = await supabase
      .from('store_pages')
      .upsert(pageRows, { onConflict: 'shopify_id' });
    if (pageErr) {
      throw new Error(`Store pages upsert failed: ${pageErr.message}`);
    }
    pageCount = pageRows.length;
  }

  const jsonExportPath = resolve(process.cwd(), 'data/ctwtech-catalog.json');
  const csvExportPath = resolve(process.cwd(), 'data/ctwtech-products.csv');

  await mkdir(dirname(jsonExportPath), { recursive: true });
  await writeFile(
    jsonExportPath,
    JSON.stringify(
      {
        storeUrl: canonicalUrl,
        currency,
        exportedAt: new Date().toISOString(),
        totalProducts: exportRecords.length,
        totalVariants: variantCount,
        products: exportRecords,
      },
      null,
      2
    ),
    'utf8'
  );
  await writeFile(csvExportPath, buildCsv(exportRecords), 'utf8');

  console.log(`  ✓ Products synced to Supabase: ${productCount} (${variantCount} variants)`);
  console.log(`  ✓ Store pages synced to Supabase: ${pageCount}`);
  console.log(`  ⚠ Data quality issues logged: ${issueCount}`);
  console.log(`  ✓ Local database exports written to data/ctwtech-catalog.json & data/ctwtech-products.csv`);

  return {
    storeUrl,
    canonicalUrl,
    products: productCount,
    variants: variantCount,
    collections: collections.length,
    pages: pageCount,
    dataQualityIssues: issueCount,
    jsonExportPath,
    csvExportPath,
  };
}
