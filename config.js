// Configuração pública do app de Ponto JFL.
// A chave abaixo é a chave pública (publishable/anon) do Supabase — feita para
// ficar exposta no navegador. Toda a proteção real dos dados está nas regras
// de RLS do banco e nas Edge Functions (que usam a service role no servidor).
window.PONTO_CONFIG = {
  SUPABASE_URL: "https://ywlbpwqoemexdxzcpbal.supabase.co",
  SUPABASE_ANON_KEY: "sb_publishable_06VQW6ZCVJDnkugb3SHyoQ_slUkBimT",
  EMAIL_DOMAIN: "jfl-portal.internal",
};
