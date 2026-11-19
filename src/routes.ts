import { category } from './contracts';

export const staffHome = '/staff';
export const staffLogin = '/staff/login';
export const residentLogin = '/login';
export const staffInventoryPage = '/staff/inventory';
export const staffCatalogPage = '/staff/equipment-types';

export function returnPath(role: 'staff' | 'resident', value: string | null) {
  if (role === 'staff') return value === staffInventoryPage || value === staffCatalogPage ? value : staffHome;
  if (value === '/') return '/';
  if (!value?.startsWith('/requests?')) return '/requests';
  const selected = new URLSearchParams(value.slice('/requests?'.length)).get('category');
  return selected && category.safeParse(selected).success ? `/requests?category=${encodeURIComponent(selected)}` : '/requests';
}
export function loginLink(role: 'staff' | 'resident', next: string) {
  return (role==='staff'?staffLogin:residentLogin)+'?returnTo='+encodeURIComponent(returnPath(role,next));
}
