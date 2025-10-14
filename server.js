import express from "express";
import axios from "axios";
import dotenv from "dotenv";
import bodyParser from "body-parser";
import Bottleneck from "bottleneck";
import cors from "cors"; // 💡 NEW: Import the CORS package

dotenv.config();
const app = express();


// --- CORS Configuration ---
const allowedOrigins = [
  'https://velonia.si',                       // Your primary custom domain
  'https://s0jd0m-rg.myshopify.com',           // 💡 PASTE THIS DOMAIN
]; 
const corsOptions = {
  origin: function (origin, callback) {
    // Allow requests with no origin (like mobile apps or curl) or if the origin is in our list
    if (!origin || allowedOrigins.includes(origin)) {
      callback(null, true);
    } else {
      callback(new Error('Not allowed by CORS'));
    }
  },
  methods: 'GET,POST,PUT,DELETE', // Allow the necessary methods (especially POST for tracking)
  allowedHeaders: 'Content-Type,Authorization',
  credentials: true
};

app.use(cors(corsOptions));


// Configure Bottleneck for rate limiting (2 requests per second)
const limiter = new Bottleneck({
  minTime: 500, // 500ms between requests (2 requests per second)
  maxConcurrent: 1 // Process one request at a time
});

// Wrap axios methods with limiter
const limitedAxiosGet = limiter.wrap(axios.get);
const limitedAxiosPost = limiter.wrap(axios.post);
const limitedAxiosPut = limiter.wrap(axios.put);
const limitedAxiosDelete = limiter.wrap(axios.delete);

// Define global constants early for helper function access
const SHOP = process.env.SHOP;
const TOKEN = process.env.TOKEN;
const API_VERSION = "2025-10";

// Helper function for Shopify REST API calls with retry logic for 429 errors
async function shopifyApiCall(method, url, data = null, headers = { "X-Shopify-Access-Token": TOKEN }) {
  const maxRetries = 3;
  let attempt = 0;

  while (attempt < maxRetries) {
    try {
      if (method === "get") {
        return await limitedAxiosGet(url, { headers });
      } else if (method === "post") {
        return await limitedAxiosPost(url, data, { headers });
      } else if (method === "put") {
        return await limitedAxiosPut(url, data, { headers });
      } else if (method === "delete") {
        return await limitedAxiosDelete(url, { headers });
      }
    } catch (err) {
      if (err.response?.status === 429) {
        const retryAfter = parseInt(err.response.headers["retry-after"] || 2, 10) * 1000;
        console.log(`Rate limit hit for ${url}, retrying after ${retryAfter}ms (attempt ${attempt + 1}/${maxRetries})`);
        await new Promise(resolve => setTimeout(resolve, retryAfter));
        attempt++;
        continue;
      }
      throw new Error(`API call failed: ${err.message}${err.response ? `, status: ${err.response.status}, data: ${JSON.stringify(err.response.data)}` : ''}`);
    }
  }
  throw new Error(`Max retries (${maxRetries}) exceeded for ${url}`);
}

// Helper function for Shopify GraphQL calls with retry logic
async function shopifyGraphQLCall(query, variables = {}) {
  const url = `https://${SHOP}/admin/api/${API_VERSION}/graphql.json`;
  const headers = { "X-Shopify-Access-Token": TOKEN, "Content-Type": "application/json" };
  const postData = { query, variables };
  const maxRetries = 3;
  let attempt = 0;

  while (attempt < maxRetries) {
    try {
      const response = await limitedAxiosPost(url, postData, { headers });
      const graphData = response.data;
      if (!graphData || typeof graphData !== 'object') {
        throw new Error(`Invalid GraphQL response: ${JSON.stringify(response.data)}`);
      }
      if (graphData.errors) {
        const hasThrottled = graphData.errors.some(e => e.extensions?.code === "THROTTLED");
        if (hasThrottled) {
          const retryAfter = 2000; // Default 2s for throttled
          console.log(`GraphQL throttled, retrying after ${retryAfter}ms (attempt ${attempt + 1}/${maxRetries})`);
          await new Promise(resolve => setTimeout(resolve, retryAfter));
          attempt++;
          continue;
        }
        throw new Error(`GraphQL errors: ${JSON.stringify(graphData.errors)}`);
      }
      if (!graphData.data) {
        throw new Error(`GraphQL response missing 'data' field: ${JSON.stringify(graphData)}`);
      }
      return graphData.data;
    } catch (err) {
      if (err.response?.status === 429) {
        const retryAfter = parseInt(err.response.headers["retry-after"] || 2, 10) * 1000;
        console.log(`Rate limit hit for GraphQL, retrying after ${retryAfter}ms (attempt ${attempt + 1}/${maxRetries})`);
        await new Promise(resolve => setTimeout(resolve, retryAfter));
        attempt++;
        continue;
      }
      throw new Error(`GraphQL call failed: ${err.message}${err.response ? `, status: ${err.response.status}, data: ${JSON.stringify(err.response.data)}` : ''}`);
    }
  }
  throw new Error(`Max retries (${maxRetries}) exceeded for GraphQL`);
}

app.use(bodyParser.urlencoded({ extended: true }));
app.use(express.json()); // <--- 💡 PASTE THIS LINE
app.use(express.static("public"));
app.set("view engine", "ejs");
app.use((req, res, next) => {
  res.setHeader("X-Frame-Options", "ALLOWALL");
  next();
});

// Validate environment variables
if (!SHOP || !TOKEN) {
  console.error("Error: SHOP and TOKEN must be defined in .env file");
  process.exit(1);
}

// --- GraphQL Mutations ---

const PRODUCT_VARIANTS_BULK_UPDATE_MUTATION = `
  mutation productVariantsBulkUpdate($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
    productVariantsBulkUpdate(productId: $productId, variants: $variants) {
      product {
        id
      }
      productVariants {
        id
        price
        inventoryItem {
          id
        }
      }
      userErrors {
        field
        message
      }
    }
  }
`;

const PRODUCT_VARIANTS_BULK_CREATE_MUTATION = `
  mutation productVariantsBulkCreate($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
    productVariantsBulkCreate(productId: $productId, variants: $variants) {
      product {
        id
      }
      productVariants {
        id
        sku
        price
        inventoryItem {
          id
        }
        image {
          id
          src
        }
      }
      userErrors {
        field
        message
      }
    }
  }
`;


// --- GraphQL Queries for Reporting ---
const BUNDLE_VARIANT_SALES_QUERY = (variantIds) => `
  query GetVariantSales {
    orders(query: "line_item_variant_ids:${variantIds.join(' OR ')}", first: 250) {
      edges {
        node {
          lineItems(first: 250) {
            edges {
              node {
                variant {
                  id
                }
                quantity
              }
            }
          }
        }
      }
      pageInfo {
        hasNextPage
        endCursor
      }
    }
  }
`;

// --- Fetching Logic ---
// --- Existing Product Fetching Logic (Updated to return mapped products) ---
// Replace your entire async function fetchProductsAndBundles() with this:
async function fetchProductsAndBundles() {
    let products = [];
    let allUniqueTags = new Set(); 
    let cursor = null;
    let allBundleVariantGids = []; // 💡 NEW: Collect all GIDs for sales query

    const query = `
        query fetchProducts($first: Int!, $after: String) {
            products(first: $first, after: $after) {
                edges {
                    node {
                        id
                        title
                        tags
                          metafield(namespace: "bundle", key: "visitors") { 
                            value
                        }
                        options {
                            id
                            name
                            values
                        }
                        variants(first: 10) {
                            edges {
                                node {
                                    id
                                    selectedOptions {
                                        name
                                        value
                                    }
                                    price
                                    inventoryItem {
                                        id
                                        inventoryLevels(first: 1) {
                                            edges {
                                                node {
                                                    quantities(names: ["available"]) {
                                                        name
                                                        quantity
                                                    }
                                                    location {
                                                        id
                                                    }
                                                }
                                            }
                                        }
                                    }
                                }
                            }
                        }
                        images(first: 1) {
                            edges {
                                node {
                                    id
                                    src
                                }
                            }
                        }
                    }
                }
                pageInfo {
                    hasNextPage
                    endCursor
                }
            }
        }
    `;

    try {
        let hasNextPage = true;
        while (hasNextPage) {
            const data = await shopifyGraphQLCall(query, { first: 250, after: cursor });
            if (!data || !data.products || !data.products.edges) {
                throw new Error(`Invalid response structure: ${JSON.stringify(data)}`);
            }

            products = products.concat(data.products.edges.map(e => e.node));
            cursor = data.products.pageInfo.endCursor;
            hasNextPage = data.products.pageInfo.hasNextPage;
        }

        const mappedProducts = products
            .map(product => {
                const mappedProduct = {
                    id: product.id.split('/').pop(),
                    title: product.title,
                    // 💡 ADDED: Capture the metafield value from the product object
                    visitors: product.metafield ? parseInt(product.metafield.value) : 0, 
                    variants: product.variants?.edges?.map(e => e.node) || [],
                    options: product.options,
                    tags: product.tags
                };
                
                (product.tags || []).forEach(tag => allUniqueTags.add(tag.trim().toLowerCase()));

                return mappedProduct;
            });

        const filteredProducts = mappedProducts
            .filter(product => {
                const variants = product.variants;
                
                const baseVariant = variants.find(v => {
                    const option1 = v.selectedOptions.find(opt => opt.name === "Bundle")?.value;
                    return !["1x", "2x", "3x"].includes(option1);
                }) || variants[0];

                if (!baseVariant) return false;

                const baseInventory = baseVariant.inventoryItem?.inventoryLevels.edges[0]?.node.quantities.find(q => q.name === "available")?.quantity || 0;

                const hasBundleVariants = variants.some(v => {
                    const option1 = v.selectedOptions.find(opt => opt.name === "Bundle")?.value;
                    return ["1x", "2x", "3x"].includes(option1);
                });

                const hasNonBundleOptions = product.options.some(opt => opt.name !== "Bundle" && opt.name !== "Title");

                // Note: filteredProducts already have the 'visitors' property, but it's not used in this section.

                return baseInventory > 3 && !hasBundleVariants && !hasNonBundleOptions;
            })
            .sort((a, b) => a.title.localeCompare(b.title));

        const bundledProducts = mappedProducts
            .filter(product =>
                product.options.some(opt =>
                    opt.name === "Bundle" &&
                    opt.values.includes("1x") &&
                    opt.values.includes("2x") &&
                    opt.values.includes("3x")
                )
            )
            .map(product => {
                let bundles = [];
                // 💡 ACCESSING THE 'visitors' PROPERTY FROM MAPPED PRODUCT
                const visitorCount = product.visitors; 
                
                (product.variants || []).forEach(variant => { 
                    const option1 = variant.selectedOptions.find(opt => opt.name === "Bundle")?.value;
                    if (["1x", "2x", "3x"].includes(option1)) {
                        const available = variant.inventoryItem.inventoryLevels.edges[0]?.node.quantities.find(q => q.name === "available")?.quantity || 0;
                        
                        allBundleVariantGids.push(variant.id); // 💡 COLLECT GID

                        bundles.push({
                            type: option1,
                            variantId: variant.id.split('/').pop(),
                            variantGid: variant.id, // 💡 STORE GID
                            price: parseFloat(variant.price).toFixed(2),
                            available,
                            totalOrders: 0 // Initialize to 0
                        });
                    }
                });
                bundles.sort((a, b) => parseInt(a.type) - parseInt(b.type));
                return bundles.length > 0 ? { 
                    id: product.id.split('/').pop(), 
                    title: product.title, 
                    bundles,
                    // 💡 ATTACHING THE VISITOR COUNT HERE
                    visitors: visitorCount 
                } : null;
            })
            .filter(p => p !== null)
            .sort((a, b) => a.title.localeCompare(b.title));
            
        // 💡 NEW STEP: Fetch and map sales data
        const salesMap = await fetchAndAggregateSales(allBundleVariantGids);

        bundledProducts.forEach(product => {
            product.bundles.forEach(bundle => {
                bundle.totalOrders = salesMap.get(bundle.variantGid) || 0;
                delete bundle.variantGid; // Clean up the GID field before passing to EJS
            });
        });

        return { 
            filteredProducts, 
            bundledProducts,
            allUniqueTags: Array.from(allUniqueTags).sort()
        };
    } catch (err) {
        console.error("Error in fetchProductsAndBundles:", err.message);
        throw new Error(`Failed to fetch products: ${err.message}`);
    }
}
async function fetchData() {
    // Only one API call needed now
    return fetchProductsAndBundles(); 
}

// 💡 NEW HELPER FUNCTION
async function fetchAndAggregateSales(variantGids) {
    if (variantGids.length === 0) return new Map();

    const salesMap = new Map();
    let hasNextPage = true;
    let cursor = null;

    // Use a large loop/pagination if you expect more than 250 orders matching the filter
    // For simplicity and to prevent hitting rate limits too hard, we limit the query.
    // NOTE: Shopify's order query filter can only handle ~50 variant IDs in one OR clause.
    // If you have many products, this logic needs to be enhanced with chunking.
    const CHUNK_SIZE = 50; 
    const chunks = [];
    for (let i = 0; i < variantGids.length; i += CHUNK_SIZE) {
        chunks.push(variantGids.slice(i, i + CHUNK_SIZE));
    }
    
    // Process chunks sequentially to manage query complexity
    for (const chunk of chunks) {
        let chunkCursor = null;
        let chunkHasNextPage = true;

        while (chunkHasNextPage) {
            const query = BUNDLE_VARIANT_SALES_QUERY(chunk);
            const data = await shopifyGraphQLCall(query, { after: chunkCursor });
            
            const orders = data?.orders?.edges || [];
            
            orders.forEach(orderEdge => {
                orderEdge.node.lineItems.edges.forEach(lineItemEdge => {
                    const variantId = lineItemEdge.node.variant?.id;
                    const quantity = lineItemEdge.node.quantity;
                    
                    if (variantId && chunk.includes(variantId)) {
                        // Aggregate quantities for accurate purchase count
                        salesMap.set(variantId, (salesMap.get(variantId) || 0) + quantity);
                    }
                });
            });

            chunkCursor = data.orders.pageInfo.endCursor;
            chunkHasNextPage = data.orders.pageInfo.hasNextPage;
        }
    }

    return salesMap;
}
async function fetchBundleMappings() {
  let mappings = [];
  let cursor = null;
  const query = `
    query fetchProducts($first: Int!, $after: String) {
      products(first: $first, after: $after) {
        edges {
          node {
            id
            options {
              id
              name
              values
            }
            variants(first: 10) {
              edges {
                node {
                  id
                  selectedOptions {
                    name
                    value
                  }
                }
              }
            }
          }
        }
        pageInfo {
          hasNextPage
          endCursor
        }
      }
    }
  `;

  try {
    let hasNextPage = true;
    while (hasNextPage) {
      const data = await shopifyGraphQLCall(query, { first: 250, after: cursor });
      if (!data || !data.products || !data.products.edges) {
        throw new Error(`Invalid response structure: ${JSON.stringify(data)}`);
      }
      const prods = data.products.edges.map(e => e.node);
      const bundleProds = prods.filter(p =>
        p.options.some(opt =>
          opt.name === "Bundle" &&
          opt.values.includes("1x") &&
          opt.values.includes("2x") &&
          opt.values.includes("3x")
        )
      );
      mappings = mappings.concat(bundleProds.map(p => {
        const variantIds = { "1x": null, "2x": null, "3x": null };
        // ✅ FIX 3: Safely access variants.edges
        (p.variants?.edges || []).forEach(({ node }) => {
          const option1 = node.selectedOptions.find(opt => opt.name === "Bundle")?.value;
          if (["1x", "2x", "3x"].includes(option1)) {
            variantIds[option1] = node.id.split('/').pop();
          }
        });
        return {
          product_id: p.id.split('/').pop().toString(),
          variant_ids: variantIds
        };
      }));
      cursor = data.products.pageInfo.endCursor;
      hasNextPage = data.products.pageInfo.hasNextPage;
    }

    return mappings;
  } catch (err) {
    console.error("Error in fetchBundleMappings:", err.message);
    throw new Error(`Failed to fetch bundle mappings: ${err.message}`);
  }
}
// ... (existing code before app.get("/") route)

// --- Metafield Constants (Ensure these match your created metafield) ---
const VISITOR_NAMESPACE = "bundle";
const VISITOR_KEY = "visitors";
const VISITOR_TYPE = "integer"; 

// 💡 NEW: Endpoint to track visitors and increment the metafield
app.post("/track-bundle-visit", async (req, res) => {
  const LOCAL_API_VERSION = "2025-01"; 
  const { product_id } = req.body;

  if (!product_id) {
    return res.status(400).json({ success: false, message: "Product ID required." });
  }

  try {
    // 1. Fetch existing metafield 
    const queryUrl = `https://${SHOP}/admin/api/${LOCAL_API_VERSION}/products/${product_id}/metafields.json?namespace=bundle&key=visitors`;
    const fetchResponse = await shopifyApiCall("get", queryUrl);

    // 💡 FIX: Check if 'metafields' array exists in the response
    const metafields = fetchResponse?.metafields || []; 
    
    // Use the safely accessed array
    const existingMetafield = metafields.find(m => m.key === 'visitors');
    
    let visitorCount = existingMetafield ? parseInt(existingMetafield.value) : 0;
    visitorCount += 1; // Increment the count

    const metafieldData = {
      metafield: {
        namespace: 'bundle',
        key: 'visitors',
        value: visitorCount.toString(), // REST API requires the value as a string
        type: 'integer',
        owner_resource: "product",
      }
    };

    if (existingMetafield) {
      // 2. Update existing metafield
      const updateUrl = `https://${SHOP}/admin/api/${LOCAL_API_VERSION}/metafields/${existingMetafield.id}.json`;
      await shopifyApiCall("put", updateUrl, metafieldData);
    } else {
      // 3. Create new metafield
      const createUrl = `https://${SHOP}/admin/api/${LOCAL_API_VERSION}/products/${product_id}/metafields.json`;
      await shopifyApiCall("post", createUrl, metafieldData);
    }
    
    console.log(`✅ Visitor count updated for product ${product_id} to ${visitorCount}`);
    res.json({ success: true, count: visitorCount });

  } catch (error) {
    // Send 500 status back to Vercel logs/browser
    console.error(`Error tracking bundle visit for ${product_id}: ${error.message}`);
    // You can now be more confident that any 500 status from here is an API/Token issue
    res.status(500).json({ success: false, message: error.message });
  }
});
// --- Express Routes ---
app.get("/", async (req, res) => {
    try {
        // Renamed structure from fetchData to match new return
        const { filteredProducts, bundledProducts, allUniqueTags } = await fetchData(); 
        
        // Pass products (renamed back for EJS consistency), bundledProducts, and allUniqueTags
        // marketCollections is now effectively replaced by allUniqueTags
        res.render("index", { 
            products: filteredProducts, 
            bundledProducts, 
            marketCollections: allUniqueTags.map(tag => ({ title: tag.toUpperCase(), tag })), // Map tags to the old collection structure
            shopDomain: SHOP, 
            message: req.query.message 
        });
    } catch (err) {
        console.error("Error fetching data in GET /:", err);
        res.status(500).send(`Error fetching data: ${err.message}`);
    }
});
app.post("/create-bundles", async (req, res) => {
  const LOCAL_API_VERSION = "2025-01";
  const CONCURRENCY_CHUNK_SIZE = 15;
  const BATCH_DELAY_MS = 300;

  // --- START MODIFICATION 1: Retrieve bundle_text ---
  let { product_ids, discount2 = 0, discount3 = 0, add_image = "false", bundle_text } = req.body;
  
  if (!bundle_text) {
    bundle_text = ""; 
  }
  // --- END MODIFICATION 1 ---
  
  product_ids = Array.isArray(product_ids) ? product_ids : [product_ids];
  discount2 = parseFloat(discount2); // Ensure discount is a float
  discount3 = parseFloat(discount3); // Ensure discount is a float
  add_image = add_image === "true";

  console.log("POST /create-bundles received:", { product_ids, discount2, discount3, add_image, bundle_text });

  if (!product_ids || product_ids.length === 0) {
    return res.redirect(
      `/?message=${encodeURIComponent("❌ Error: At least one Product ID is required.")}`
    );
  }

  // GraphQL helper (kept for other operations)
  const shopifyGraphQLCall = async (query, variables = {}) => {
    try {
      const response = await axios.post(
        `https://${SHOP}/admin/api/${LOCAL_API_VERSION}/graphql.json`,
        { query, variables },
        {
          headers: {
            "X-Shopify-Access-Token": TOKEN,
            "Content-Type": "application/json",
          },
        }
      );
      if (response.data.errors) throw new Error(JSON.stringify(response.data.errors));
      return response.data.data;
    } catch (err) {
      throw new Error(`GraphQL call failed: ${err.message}`);
    }
  };
  
  // REST API helper (Assuming you have shopifyApiCall defined elsewhere, likely using Axios/fetch)
  // If shopifyApiCall is NOT defined, replace with your preferred REST client logic (e.g., Axios post/put)
  const shopifyApiCall = async (method, url, data = null) => {
    // This is a placeholder/assumption. Ensure your actual REST wrapper is available.
    // For this example, we assume `axios` is available and TOKEN/SHOP are defined.
    const config = {
        method: method.toLowerCase(),
        url: url,
        headers: {
            "X-Shopify-Access-Token": TOKEN,
            "Content-Type": "application/json",
        },
        data: data
    };
    const response = await axios(config);
    return response.data;
  };

  // Remove Default Title variant
  const removeDefaultVariant = async (productId) => {
    try {
      const query = `
        query {
          product(id: "gid://shopify/Product/${productId}") {
            variants(first: 10) { edges { node { id title } } }
            images(first: 1) { edges { node { id src } } }
          }
        }
      `;
      const data = await shopifyGraphQLCall(query);
      const variants = data.product?.variants?.edges || [];
      const defaultVar = variants.find((v) => v.node.title === "Default Title");

      if (defaultVar) {
        const variantIdNum = defaultVar.node.id.split("/").pop();
        const variantUrl = `https://${SHOP}/admin/api/${LOCAL_API_VERSION}/products/${productId}/variants/${variantIdNum}.json`;
        await shopifyApiCall("delete", variantUrl);
        console.log(`🗑️ Deleted Default Title variant for product ${productId}`);
      }

      // Return main image info for later image linking
      const mainImageNode = data.product?.images?.edges?.[0]?.node || null;
      return mainImageNode;
    } catch (err) {
      console.warn(`⚠️ Error removing Default Title for ${productId}: ${err.message}`);
      return null;
    }
  };

  const chunkArray = (arr, size) => {
    const chunks = [];
    for (let i = 0; i < arr.length; i += size) chunks.push(arr.slice(i, i + size));
    return chunks;
  };

  const processProduct = async (product_id) => {
    try {
      const productQuery = `
        query getProduct($id: ID!) {
          product(id: $id) {
            id
            title
            options { id name values }
            variants(first: 10) {
              edges {
                node {
                  id
                  selectedOptions { name value }
                  price
                  sku
                  inventoryItem {
                    id
                    inventoryLevels(first: 1) {
                      edges {
                        node {
                          quantities(names: ["available"]) { name quantity }
                          location { id }
                        }
                      }
                    }
                  }
                }
              }
            }
            images(first: 1) { edges { node { id src } } }
          }
        }
      `;

      const productGid = `gid://shopify/Product/${product_id}`;
      let data = await shopifyGraphQLCall(productQuery, { id: productGid });
      const product = data?.product;
      if (!product) throw new Error(`Product not found (${product_id})`);
      
      // --- START MODIFICATION 2: Set bundle.extra_text metafield using REST API ---
      if (bundle_text !== "") {
          const metafieldUrl = `https://${SHOP}/admin/api/${LOCAL_API_VERSION}/products/${product_id}/metafields.json`;
          
         const metafieldData = {
              metafield: {
                  namespace: "bundle",
                  key: "extra_text", 
                  value: bundle_text,
                  // FIX: Using 'single_line_text_field' as requested
                  type: "single_line_text_field" 
              }
          };

          try {
              await shopifyApiCall("post", metafieldUrl, metafieldData);
              console.log(`📝 Metafield 'bundle.extra_text' set (type: string) via REST for product ${product_id}`);
          } catch (err) {
              console.warn(`⚠️ Metafield update failed for ${product_id}: ${err.message}`);
          }
      }
      // --- END MODIFICATION 2 ---

      const variants = product.variants.edges.map((e) => e.node);
      if (!variants.length) throw new Error("No variants found.");

      const baseVariant =
        variants.find((v) => {
          const opt = v.selectedOptions.find((o) => o.name === "Bundle");
          return !opt || !["1x", "2x", "3x"].includes(opt.value);
        }) || variants[0];

      const basePrice = parseFloat(baseVariant.price);
      const baseInventoryLevel = baseVariant.inventoryItem.inventoryLevels.edges[0]?.node;
      const baseInventory =
        baseInventoryLevel?.quantities.find((q) => q.name === "available")?.quantity || 0;
      const locationId = baseInventoryLevel?.location?.id;

      if (!locationId) throw new Error("No inventory location found.");
      if (baseInventory <= 0) throw new Error("No inventory available.");

      // Delete old variants
      for (const variant of variants) {
        const variantId = variant.id.split("/").pop();
        const variantUrl = `https://${SHOP}/admin/api/${LOCAL_API_VERSION}/products/${product_id}/variants/${variantId}.json`;
        try { await shopifyApiCall("delete", variantUrl); } catch {}
      }

      // Update product options
      const productUrl = `https://${SHOP}/admin/api/${LOCAL_API_VERSION}/products/${product_id}.json`;
      await shopifyApiCall("put", productUrl, {
        product: { id: product_id, options: [{ name: "Bundle", values: ["1x", "2x", "3x"] }] },
      });

      data = await shopifyGraphQLCall(productQuery, { id: productGid });
      const bundleOption = data?.product?.options.find((opt) => opt.name === "Bundle");
      if (!bundleOption) throw new Error("Bundle option not found after update.");

      // Prepare bundles
      const bundles = [
        { title: "1x Bundle", qty: 1, price: basePrice, inventory: Math.floor(baseInventory / 1) },
        { title: "2x Bundle", qty: 2, price: basePrice * 2 * (1 - discount2 / 100), inventory: Math.floor(baseInventory / 2) },
        { title: "3x Bundle", qty: 3, price: basePrice * 3 * (1 - discount3 / 100), inventory: Math.floor(baseInventory / 3) },
      ];

      const variantsToCreate = bundles.map((b) => ({
        optionValues: [{ optionId: bundleOption.id, name: `${b.qty}x` }],
        price: b.price.toFixed(2),
        inventoryItem: { sku: `${product_id}-${b.qty}x-BUNDLE` },
        inventoryQuantities: [{ locationId, availableQuantity: b.inventory }],
      }));

      const PRODUCT_VARIANTS_BULK_CREATE_MUTATION = `
        mutation ProductVariantsBulkCreate($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
          productVariantsBulkCreate(productId: $productId, variants: $variants) {
            productVariants { id title }
            userErrors { field message }
          }
        }
      `;

      const createData = await shopifyGraphQLCall(PRODUCT_VARIANTS_BULK_CREATE_MUTATION, {
        productId: product.id,
        variants: variantsToCreate,
      });

      if (createData.productVariantsBulkCreate.userErrors.length) {
        throw new Error(JSON.stringify(createData.productVariantsBulkCreate.userErrors));
      }

      // Remove Default Title & get main image
      const mainImageNode = await removeDefaultVariant(product_id);

      // 🔹 REST image upload
      if (add_image && mainImageNode) {
        const mainImageId = mainImageNode.id.split("/").pop();
        for (const variant of createData.productVariantsBulkCreate.productVariants) {
          const variantIdNum = variant.id.split("/").pop();
          const variantUrl = `https://${SHOP}/admin/api/${LOCAL_API_VERSION}/products/${product_id}/variants/${variantIdNum}.json`;
          try {
            await shopifyApiCall("put", variantUrl, { variant: { id: variantIdNum, image_id: mainImageId } });
          } catch (err) {
            console.warn(`⚠️ Could not link image for variant ${variantIdNum}: ${err.message}`);
          }
        }
      }

      return { product_id, success: `✅ Bundles created successfully for product ${product_id}` };

    } catch (err) {
      console.error(`❌ Error processing product ${product_id}:`, err.message);
      throw new Error(`Error processing product ${product_id}: ${err.message}`);
    }
  };

  // Process products in chunks
  const productChunks = chunkArray(product_ids, CONCURRENCY_CHUNK_SIZE);
  let allSettledResults = [];

  for (const chunk of productChunks) {
    const promises = chunk.map(processProduct);
    const settledResults = await Promise.allSettled(promises);
    allSettledResults = allSettledResults.concat(settledResults);
    if (productChunks.indexOf(chunk) < productChunks.length - 1) {
      await new Promise((resolve) => setTimeout(resolve, BATCH_DELAY_MS));
    }
  }

  // Aggregate results
  const results = allSettledResults.map((result) => {
    if (result.status === "fulfilled") return result.value;
    const errorMessage = result.reason.message || "Unknown error occurred";
    const match = errorMessage.match(/Error processing product (\d+):/);
    const product_id = match ? match[1] : "Unknown ID";
    const errorDetail = errorMessage.replace(/Error processing product \d+: /, "");
    return { product_id, error: errorDetail };
  });

  const message = results
    .map((r) => (r.success ? r.success : `❌ Error processing product ${r.product_id}: ${r.error}`))
    .join("<br>");
  res.redirect(`/?message=${encodeURIComponent(message)}#create-bundles`);
});


app.post("/update-bundles", async (req, res) => {
  const LOCAL_API_VERSION = "2025-01"; // ✅ use same as create-bundles
  let { product_ids, discount2 = 0, discount3 = 0 } = req.body;
  product_ids = Array.isArray(product_ids) ? product_ids : [product_ids];

  console.log("POST /update-bundles received:", { product_ids, discount2, discount3 });

  if (!product_ids || product_ids.length === 0) {
    return res.redirect(
      `/?message=${encodeURIComponent("❌ Error: At least one Product ID is required.")}#update-bundles`
    );
  }

  const results = [];

  // ✅ Helper: GraphQL API call
  const shopifyGraphQLCall = async (query, variables = {}) => {
    try {
      const response = await axios.post(
        `https://${SHOP}/admin/api/${LOCAL_API_VERSION}/graphql.json`,
        { query, variables },
        {
          headers: {
            "X-Shopify-Access-Token": TOKEN,
            "Content-Type": "application/json",
          },
        }
      );
      if (response.data.errors) throw new Error(JSON.stringify(response.data.errors));
      return response.data.data;
    } catch (err) {
      throw new Error(`GraphQL call failed: ${err.message}`);
    }
  };

  // ✅ Mutation for bulk variant update
  const PRODUCT_VARIANTS_BULK_UPDATE_MUTATION = `
    mutation ProductVariantsBulkUpdate($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
      productVariantsBulkUpdate(productId: $productId, variants: $variants) {
        productVariants { id title price }
        userErrors { field message }
      }
    }
  `;

  // ✅ Process each product
  for (const product_id of product_ids) {
    try {
      // Step 1: Fetch product variants via GraphQL
      const productQuery = `
        query getProduct($id: ID!) {
          product(id: $id) {
            id
            title
            variants(first: 10) {
              edges {
                node {
                  id
                  title
                  price
                  selectedOptions { name value }
                }
              }
            }
          }
        }
      `;
      const productGid = `gid://shopify/Product/${product_id}`;
      const data = await shopifyGraphQLCall(productQuery, { id: productGid });
      const product = data?.product;
      if (!product) throw new Error(`Product not found (${product_id})`);

      const variants = product.variants.edges.map((e) => e.node);
      if (!variants.length) throw new Error("No variants found.");

      // Find base price (non-bundle or 1x)
      const baseVariant =
        variants.find((v) => {
          const opt = v.selectedOptions.find((o) => o.name === "Bundle");
          return !opt || !["1x", "2x", "3x"].includes(opt.value);
        }) || variants[0];

      const basePrice = parseFloat(baseVariant.price);
      console.log(`Base variant: ${baseVariant.title}, Base price: ${basePrice}`);

      // Step 2: Find 2x and 3x bundle variants
      const variant2x = variants.find((v) =>
        v.selectedOptions.some((o) => o.value === "2x")
      );
      const variant3x = variants.find((v) =>
        v.selectedOptions.some((o) => o.value === "3x")
      );

      // Step 3: Prepare updates
      const updates = [];
      if (variant2x) {
        updates.push({
          id: variant2x.id,
          price: (basePrice * 2 * (1 - discount2 / 100)).toFixed(2),
        });
      }
      if (variant3x) {
        updates.push({
          id: variant3x.id,
          price: (basePrice * 3 * (1 - discount3 / 100)).toFixed(2),
        });
      }

      if (!updates.length) {
        results.push({
          product_id,
          error: "No bundle variants (2x/3x) found to update.",
        });
        continue;
      }

      // Step 4: Bulk update prices via GraphQL
      const updateResp = await shopifyGraphQLCall(PRODUCT_VARIANTS_BULK_UPDATE_MUTATION, {
        productId: product.id,
        variants: updates,
      });

      const errors = updateResp.productVariantsBulkUpdate.userErrors || [];
      if (errors.length > 0) {
        throw new Error(`GraphQL update errors: ${JSON.stringify(errors)}`);
      }

      const updated = updateResp.productVariantsBulkUpdate.productVariants.map(
        (v) => `${v.title} → ${v.price}`
      );
      console.log(`✅ Updated: ${updated.join(", ")}`);

      results.push({
        product_id,
        success: `Updated variants (${updated.join(", ")})`,
      });
    } catch (err) {
      console.error(`❌ Error processing product ${product_id}:`, err.message);
      results.push({ product_id, error: err.message });
    }
  }

  const message = results
    .map((r) => (r.success ? `✅ ${r.success}` : `❌ ${r.error}`))
    .join("<br>");
  res.redirect(`/?message=${encodeURIComponent(message)}#update-bundles`);
});

// Sync bundle inventory route (manual)
app.post("/sync-bundle-inventory", async (req, res) => {
  const { product_id, variant_ids } = req.body;

  if (!product_id || !variant_ids) {
    console.error("Missing product_id or variant_ids");
    return res.redirect(`/?message=${encodeURIComponent("❌ Error: Product ID and variant IDs are required.")}`);
  }

  try {
    // Fetch product details
    const productQuery = `
      query getProduct($id: ID!) {
        product(id: $id) {
          id
          variants(first: 10) {
            edges {
              node {
                id
                selectedOptions {
                  name
                  value
                }
                sku
                inventoryItem {
                  id
                  inventoryLevels(first: 1) {
                    edges {
                      node {
                        quantities(names: ["available"]) {
                          name
                          quantity
                        }
                        location {
                          id
                        }
                      }
                    }
                  }
                }
              }
            }
          }
        }
      }
    `;
    const productGid = `gid://shopify/Product/${product_id}`;
    const data = await shopifyGraphQLCall(productQuery, { id: productGid });
    if (!data || !data.product) {
      throw new Error(`Invalid product response: ${JSON.stringify(data)}`);
    }
    const product = data.product;

    if (!product) {
      return res.redirect(`/?message=${encodeURIComponent("❌ Error: Product not found.")}`);
    }

    const variants = product.variants.edges.map(e => e.node);
    const baseVariant = variants.find(v => {
      const option1 = v.selectedOptions.find(opt => opt.name === "Bundle")?.value;
      return !["1x", "2x", "3x"].includes(option1);
    });
    if (!baseVariant) {
      return res.redirect(`/?message=${encodeURIComponent("❌ Error: No base variant found for product.")}`);
    }

    const baseInventoryLevel = baseVariant.inventoryItem.inventoryLevels.edges[0]?.node;
    const baseInventory = baseInventoryLevel?.quantities.find(q => q.name === "available")?.quantity || 0;
    const locationId = baseInventoryLevel?.location.id;
    console.log("Base Inventory for sync:", baseInventory, "Location ID:", locationId ? locationId.split('/').pop() : 'none');

    if (!locationId) {
      return res.redirect(`/?message=${encodeURIComponent("❌ Error: No location found for base variant inventory.")}`);
    }

    // Update bundle variant inventories
    const inventoryToSet = [];

    for (const [bundleType, variantIdNum] of Object.entries(variant_ids)) {
      const qty = parseInt(bundleType);
      const newInventory = Math.floor(baseInventory / qty);
      const variantGid = `gid://shopify/ProductVariant/${variantIdNum}`;
      const variant = variants.find(v => v.id === variantGid);
      if (!variant) continue;

      const inventoryItemId = variant.inventoryItem.id;

      inventoryToSet.push({
        inventoryItemId,
        locationId,
        quantity: newInventory >= 0 ? newInventory : 0
      });
    }

    if (inventoryToSet.length > 0) {
      const inventoryMutation = `
        mutation inventorySetQuantities($input: InventorySetQuantitiesInput!) {
          inventorySetQuantities(input: $input) {
            inventoryAdjustmentGroup {
              id
            }
            userErrors {
              field
              message
            }
          }
        }
      `;
      const input = {
        name: "available",
        reason: "correction",
        quantities: inventoryToSet.map(s => ({
          inventoryItemId: s.inventoryItemId,
          locationId: s.locationId,
          quantity: s.quantity
        }))
      };
      const inventoryData = await shopifyGraphQLCall(inventoryMutation, { input });
      if (inventoryData.inventorySetQuantities.userErrors.length > 0) {
        throw new Error(JSON.stringify(inventoryData.inventorySetQuantities.userErrors));
      }
      console.log("Bundle inventory synced successfully");
    }

    res.redirect(`/?message=${encodeURIComponent("✅ Bundle inventory synced successfully")}`);
  } catch (err) {
    console.error("Error syncing inventory:", err);
    res.redirect(`/?message=${encodeURIComponent(`❌ Error syncing inventory: ${err.message}`)}`);
  }
});

// ... (existing code up to app.post("/delete-bundles", ...) )

app.post("/delete-bundles", async (req, res) => {
  const LOCAL_API_VERSION = "2025-01"; 
  const { product_id } = req.body;

  if (!product_id) {
    return res.redirect(
      `/?message=${encodeURIComponent("❌ Error: Product ID is required for deletion.")}#existing-bundles`
    );
  }

  try {
    // 1. Fetch all product variants using GraphQL for reliability
    const productGid = `gid://shopify/Product/${product_id}`;
    const productQuery = `
      query getProductVariants($id: ID!) {
        product(id: $id) {
          variants(first: 20) { 
            edges { 
              node { 
                id 
                selectedOptions { name value }
              } 
            } 
          }
        }
      }
    `;

    const data = await shopifyGraphQLCall(productQuery, { id: productGid });
    const variants = data?.product?.variants?.edges.map(e => e.node) || [];
    
    if (variants.length === 0) {
        throw new Error("GraphQL returned no variants for this product ID.");
    }

    // 2. Identify and delete bundle variants (1x, 2x, 3x) using REST
    const bundleVariantsToDelete = variants.filter(v => {
        const bundleOption = v.selectedOptions.find(o => o.name === "Bundle");
        return bundleOption && ["1x", "2x", "3x"].includes(bundleOption.value);
    });

    if (bundleVariantsToDelete.length === 0) {
        console.warn(`Product ${product_id}: No 1x/2x/3x bundle variants found to delete.`);
    }

    let deletedCount = 0;
    for (const variant of bundleVariantsToDelete) {
        // Extract numeric ID from GraphQL GID (e.g., "gid://shopify/ProductVariant/123456789")
        const variantIdNum = variant.id.split("/").pop(); 
        const variantDeleteUrl = `https://${SHOP}/admin/api/${LOCAL_API_VERSION}/products/${product_id}/variants/${variantIdNum}.json`;
        
        try {
            // Use the REST API delete call
            await shopifyApiCall("delete", variantDeleteUrl);
            deletedCount++;
        } catch (err) {
            console.warn(`⚠️ Failed to delete variant ${variantIdNum} for ${product_id}: ${err.message}`);
        }
    }
    
    // 3. Update product options to remove 'Bundle' and reset to 'Title'
    const productUpdateUrl = `https://${SHOP}/admin/api/${LOCAL_API_VERSION}/products/${product_id}.json`;
    
    const updateData = {
        product: { 
            id: product_id, 
            // Setting options to just [{ name: "Title" }] forces Shopify to revert to a 
            // single-variant product structure if it was a simple product originally.
            options: [{ name: "Title" }] 
        },
    };
    // Use the REST API put call
    await shopifyApiCall("put", productUpdateUrl, updateData);

    const message = `✅ Successfully deleted ${deletedCount} bundle variants and reverted options for product ${product_id}.`;
    console.log(message);
    res.redirect(`/?message=${encodeURIComponent(message)}#existing-bundles`);

  } catch (err) {
    console.error(`❌ Error deleting bundles for product ${product_id}:`, err.message);
    res.redirect(
      `/?message=${encodeURIComponent(`❌ Error deleting bundles for product ${product_id}: ${err.message}`)}#existing-bundles`
    );
  }
});

// ... (existing code continues from here)

// Start the server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});
