// Seeded Malaysian merchant/keyword dictionary. Phrases map to SEEDED category
// names (see supabase/migrations/20260815190045_accounts_categories.sql) and
// are resolved against ctx.categories by case-insensitive name + kind at parse
// time — entries whose category the user renamed or archived simply never match.
export const DICTIONARY: ReadonlyArray<{
  phrase: string;
  category: string;
  kind: "expense" | "income";
}> = [
  // Eating out
  { phrase: "mamak", category: "Eating out", kind: "expense" },
  { phrase: "nasi lemak", category: "Eating out", kind: "expense" },
  { phrase: "kopitiam", category: "Eating out", kind: "expense" },
  { phrase: "mcd", category: "Eating out", kind: "expense" },
  { phrase: "mcdonalds", category: "Eating out", kind: "expense" },
  { phrase: "kfc", category: "Eating out", kind: "expense" },
  { phrase: "makan", category: "Eating out", kind: "expense" },
  { phrase: "lunch", category: "Eating out", kind: "expense" },
  { phrase: "dinner", category: "Eating out", kind: "expense" },
  { phrase: "breakfast", category: "Eating out", kind: "expense" },
  { phrase: "cafe", category: "Eating out", kind: "expense" },
  // Delivery
  { phrase: "foodpanda", category: "Delivery", kind: "expense" },
  { phrase: "grabfood", category: "Delivery", kind: "expense" },
  { phrase: "delivery", category: "Delivery", kind: "expense" },
  // Groceries
  { phrase: "groceries", category: "Groceries", kind: "expense" },
  { phrase: "jaya grocer", category: "Groceries", kind: "expense" },
  { phrase: "lotus", category: "Groceries", kind: "expense" },
  { phrase: "aeon", category: "Groceries", kind: "expense" },
  { phrase: "99 speedmart", category: "Groceries", kind: "expense" },
  { phrase: "pasar", category: "Groceries", kind: "expense" },
  // Grab
  { phrase: "grab", category: "Grab", kind: "expense" },
  // Petrol
  { phrase: "petrol", category: "Petrol", kind: "expense" },
  { phrase: "shell", category: "Petrol", kind: "expense" },
  { phrase: "petronas", category: "Petrol", kind: "expense" },
  { phrase: "caltex", category: "Petrol", kind: "expense" },
  { phrase: "bhp", category: "Petrol", kind: "expense" },
  { phrase: "minyak", category: "Petrol", kind: "expense" },
  // Tolls
  { phrase: "toll", category: "Tolls", kind: "expense" },
  { phrase: "tol", category: "Tolls", kind: "expense" },
  // Parking
  { phrase: "parking", category: "Parking", kind: "expense" },
  { phrase: "parkir", category: "Parking", kind: "expense" },
  // Phone
  { phrase: "maxis", category: "Phone", kind: "expense" },
  { phrase: "celcom", category: "Phone", kind: "expense" },
  { phrase: "digi", category: "Phone", kind: "expense" },
  { phrase: "umobile", category: "Phone", kind: "expense" },
  { phrase: "prepaid", category: "Phone", kind: "expense" },
  // Internet
  { phrase: "unifi", category: "Internet", kind: "expense" },
  { phrase: "wifi", category: "Internet", kind: "expense" },
  // Electricity
  { phrase: "tnb", category: "Electricity", kind: "expense" },
  { phrase: "elektrik", category: "Electricity", kind: "expense" },
  // Rent
  { phrase: "rent", category: "Rent", kind: "expense" },
  { phrase: "sewa", category: "Rent", kind: "expense" },
  // Shopping
  { phrase: "shopee", category: "Shopping", kind: "expense" },
  { phrase: "lazada", category: "Shopping", kind: "expense" },
  { phrase: "uniqlo", category: "Shopping", kind: "expense" },
  { phrase: "mr diy", category: "Shopping", kind: "expense" },
  // Subscriptions
  { phrase: "netflix", category: "Subscriptions", kind: "expense" },
  { phrase: "spotify", category: "Subscriptions", kind: "expense" },
  { phrase: "youtube", category: "Subscriptions", kind: "expense" },
  { phrase: "disney", category: "Subscriptions", kind: "expense" },
  { phrase: "icloud", category: "Subscriptions", kind: "expense" },
  // Entertainment
  { phrase: "cinema", category: "Entertainment", kind: "expense" },
  { phrase: "gsc", category: "Entertainment", kind: "expense" },
  { phrase: "tgv", category: "Entertainment", kind: "expense" },
  { phrase: "wayang", category: "Entertainment", kind: "expense" },
  // Health
  { phrase: "clinic", category: "Health", kind: "expense" },
  { phrase: "klinik", category: "Health", kind: "expense" },
  { phrase: "pharmacy", category: "Health", kind: "expense" },
  { phrase: "guardian", category: "Health", kind: "expense" },
  { phrase: "watsons", category: "Health", kind: "expense" },
  { phrase: "ubat", category: "Health", kind: "expense" },
  // Zakat & donations
  { phrase: "zakat", category: "Zakat & donations", kind: "expense" },
  { phrase: "sedekah", category: "Zakat & donations", kind: "expense" },
  { phrase: "derma", category: "Zakat & donations", kind: "expense" },
  // Income
  { phrase: "salary", category: "Salary", kind: "income" },
  { phrase: "gaji", category: "Salary", kind: "income" },
  { phrase: "bonus", category: "Bonus", kind: "income" },
  { phrase: "freelance", category: "Freelance", kind: "income" },
  { phrase: "interest", category: "Interest", kind: "income" },
  { phrase: "mmf", category: "Interest", kind: "income" },
  { phrase: "faedah", category: "Interest", kind: "income" },
  { phrase: "dividend", category: "Dividends", kind: "income" },
  { phrase: "dividen", category: "Dividends", kind: "income" },
  { phrase: "asb", category: "Dividends", kind: "income" },
];
