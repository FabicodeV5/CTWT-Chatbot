import { supabase } from '../db/supabase.js';
import { shopifyGraphql } from './client.js';

interface PageInfo {
  hasNextPage: boolean;
  endCursor: string | null;
}

const LOCATIONS_QUERY = `
  query GetLocations($cursor: String) {
    locations(first: 50, after: $cursor, includeLegacy: true) {
      nodes {
        id
        name
        isActive
      }
      pageInfo { hasNextPage endCursor }
    }
  }
`;

const PRODUCTS_QUERY = `
  query GetProducts($cursor: String) {
    products(first: 20, after: $cursor) {
      nodes {
        id
        handle
        title
        vendor
        productType
        tags
        description
        status
        onlineStoreUrl
        updatedAt
        featuredImage { url }
        priceRangeV2 {
          minVariantPrice { amount currencyCode }
          maxVariantPrice { amount currencyCode }
        }
        metafields(first: 30) {
          nodes { namespace key value type }
        }
        variants(first: 50) {
          nodes {
            id
            title
            sku
            barcode
            price
            compareAtPrice
            position
            inventoryItem {
              id
              tracked
              inventoryLevels(first: 10) {
                nodes {
                  location { id }
                  quantities(names: ["available"]) { name quantity }
                }
              }
            }
          }
        }
      }
      pageInfo { hasNextPage endCursor }
    }
  }
`;

const PAGES_QUERY = `
  query GetPages($cursor: String) {
    pages(first: 50, after: $cursor) {
      nodes {
        id
        handle
        title
        body
      }
      pageInfo { hasNextPage endCursor }
    }
  }
`;

export async function syncLocations() {
  let cursor: string | null = null;
  const shopifyToDbId = new Map<string, string>();

  do {
    const data: {
      locations: {
        nodes: Array<{ id: string; name: string; isActive: boolean }>;
        pageInfo: PageInfo;
      };
    } = await shopifyGraphql(LOCATIONS_QUERY, { cursor });

    for (const loc of data.locations.nodes) {
      const { data: row, error } = await supabase
        .from('locations')
        .upsert(
          {
            shopify_id: loc.id,
            name: loc.name,
            is_active: loc.isActive,
          },
          { onConflict: 'shopify_id' }
        )
        .select('id')
        .single();

      if (error) throw new Error(`Location upsert failed (${loc.name}): ${error.message}`);
      shopifyToDbId.set(loc.id, row.id);
    }

    cursor = data.locations.pageInfo.hasNextPage ? data.locations.pageInfo.endCursor : null;
  } while (cursor);

  return shopifyToDbId;
}

export async function syncProducts(locationMap: Map<string, string>) {
  let cursor: string | null = null;
  let productCount = 0;
  let variantCount = 0;
  let issueCount = 0;

  do {
    const data: {
      products: {
        nodes: Array<{
          id: string;
          handle: string;
          title: string;
          vendor: string;
          productType: string;
          tags: string[];
          description: string;
          status: string;
          onlineStoreUrl: string | null;
          updatedAt: string;
          featuredImage: { url: string } | null;
          priceRangeV2: {
            minVariantPrice: { amount: string; currencyCode: string };
            maxVariantPrice: { amount: string; currencyCode: string };
          };
          metafields: { nodes: Array<{ namespace: string; key: string; value: string; type: string }> };
          variants: {
            nodes: Array<{
              id: string;
              title: string;
              sku: string | null;
              barcode: string | null;
              price: string;
              compareAtPrice: string | null;
              position: number;
              inventoryItem: {
                id: string;
                tracked: boolean;
                inventoryLevels: {
                  nodes: Array<{
                    location: { id: string };
                    quantities: Array<{ name: string; quantity: number }>;
                  }>;
                };
              } | null;
            }>;
          };
        }>;
        pageInfo: PageInfo;
      };
    } = await shopifyGraphql(PRODUCTS_QUERY, { cursor });

    for (const p of data.products.nodes) {
      const metafieldsObj: Record<string, string> = {};
      for (const mf of p.metafields.nodes) {
        metafieldsObj[`${mf.namespace}.${mf.key}`] = mf.value;
      }

      const priceMin = Number(p.priceRangeV2.minVariantPrice.amount);
      const priceMax = Number(p.priceRangeV2.maxVariantPrice.amount);
      const currency = p.priceRangeV2.minVariantPrice.currencyCode || 'GYD';
      const isPublished = Boolean(p.onlineStoreUrl) || p.status === 'ACTIVE';

      const { data: prodRow, error: prodErr } = await supabase
        .from('products')
        .upsert(
          {
            shopify_id: p.id,
            handle: p.handle,
            title: p.title,
            vendor: p.vendor || null,
            product_type: p.productType || null,
            tags: p.tags ?? [],
            description: p.description || null,
            status: p.status,
            is_published: isPublished,
            url: p.onlineStoreUrl,
            image_url: p.featuredImage?.url ?? null,
            metafields: metafieldsObj,
            price_min: Number.isFinite(priceMin) ? priceMin : null,
            price_max: Number.isFinite(priceMax) ? priceMax : null,
            currency,
            shopify_updated_at: p.updatedAt,
            synced_at: new Date().toISOString(),
          },
          { onConflict: 'shopify_id' }
        )
        .select('id')
        .single();

      if (prodErr) throw new Error(`Product upsert failed (${p.title}): ${prodErr.message}`);
      productCount++;

      await supabase
        .from('data_quality_issues')
        .delete()
        .eq('product_id', prodRow.id)
        .eq('resolved', false);

      const issues: Array<{ product_id: string; issue_type: string; details: string }> = [];
      if (p.handle.endsWith('-copy') || /-copy-\d+$/.test(p.handle)) {
        issues.push({
          product_id: prodRow.id,
          issue_type: 'duplicate_copy',
          details: `Handle ends with copy pattern: ${p.handle}`,
        });
      }
      if (!Number.isFinite(priceMin) || priceMin === 0) {
        issues.push({
          product_id: prodRow.id,
          issue_type: priceMin === 0 ? 'price_zero' : 'missing_price',
          details: `Product "${p.title}" has min price ${priceMin}`,
        });
      }

      for (const v of p.variants.nodes) {
        const vPrice = Number(v.price);
        const vCompare = v.compareAtPrice ? Number(v.compareAtPrice) : null;
        const tracked = Boolean(v.inventoryItem?.tracked);

        if (!tracked && p.status === 'ACTIVE') {
          issues.push({
            product_id: prodRow.id,
            issue_type: 'untracked_inventory',
            details: `Variant "${v.title}" (SKU: ${v.sku ?? 'none'}) does not track inventory`,
          });
        }

        const { data: varRow, error: varErr } = await supabase
          .from('product_variants')
          .upsert(
            {
              shopify_id: v.id,
              product_id: prodRow.id,
              title: v.title,
              sku: v.sku || null,
              barcode: v.barcode || null,
              price: Number.isFinite(vPrice) ? vPrice : null,
              compare_at_price: vCompare && Number.isFinite(vCompare) ? vCompare : null,
              inventory_item_id: v.inventoryItem?.id ?? null,
              inventory_tracked: tracked,
              position: v.position,
            },
            { onConflict: 'shopify_id' }
          )
          .select('id')
          .single();

        if (varErr) throw new Error(`Variant upsert failed (${v.id}): ${varErr.message}`);
        variantCount++;

        const levels = v.inventoryItem?.inventoryLevels.nodes ?? [];
        for (const lvl of levels) {
          const dbLocationId = locationMap.get(lvl.location.id);
          if (!dbLocationId) continue;

          const avail = lvl.quantities.find((q) => q.name === 'available')?.quantity ?? null;
          const { error: invErr } = await supabase
            .from('inventory_levels')
            .upsert(
              {
                variant_id: varRow.id,
                location_id: dbLocationId,
                quantity: avail,
                updated_at: new Date().toISOString(),
              },
              { onConflict: 'variant_id,location_id' }
            );

          if (invErr) throw new Error(`Inventory upsert failed: ${invErr.message}`);
        }
      }

      if (issues.length > 0) {
        await supabase.from('data_quality_issues').insert(issues);
        issueCount += issues.length;
      }
    }

    cursor = data.products.pageInfo.hasNextPage ? data.products.pageInfo.endCursor : null;
  } while (cursor);

  return { productCount, variantCount, issueCount };
}

export async function syncPages(): Promise<number> {
  let cursor: string | null = null;
  let count = 0;

  do {
    const data: {
      pages: {
        nodes: Array<{ id: string; handle: string; title: string; body: string | null }>;
        pageInfo: PageInfo;
      };
    } = await shopifyGraphql(PAGES_QUERY, { cursor });

    for (const page of data.pages.nodes) {
      const plainText = page.body ? page.body.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim() : null;
      const { error } = await supabase
        .from('store_pages')
        .upsert(
          {
            shopify_id: page.id,
            handle: page.handle,
            title: page.title,
            body: plainText,
            synced_at: new Date().toISOString(),
          },
          { onConflict: 'shopify_id' }
        );

      if (error) throw new Error(`Page upsert failed (${page.title}): ${error.message}`);
      count++;
    }

    cursor = data.pages.pageInfo.hasNextPage ? data.pages.pageInfo.endCursor : null;
  } while (cursor);

  return count;
}

export async function runFullSync() {
  console.log('🔄 Starting full Shopify sync...');
  const locationMap = await syncLocations();
  console.log(`  ✓ Locations synced: ${locationMap.size}`);

  const { productCount, variantCount, issueCount } = await syncProducts(locationMap);
  console.log(`  ✓ Products synced: ${productCount} (${variantCount} variants)`);
  console.log(`  ⚠ Data quality issues logged: ${issueCount}`);

  const pageCount = await syncPages();
  console.log(`  ✓ Store pages synced: ${pageCount}`);

  return {
    locations: locationMap.size,
    products: productCount,
    variants: variantCount,
    pages: pageCount,
    dataQualityIssues: issueCount,
  };
}