import { categories } from '../config/settings';

export const staffHome = '/staff';
export const staffLogin = '/staff/login';
export const residentLogin = '/login';
export const staffInventoryPage = '/staff/inventory';

export function returnPath(role: 'staff' | 'resident', value: string | null) {
  if (role === 'staff') return value === staffInventoryPage ? staffInventoryPage : staffHome;
  if (value === '/') return '/';
  if (!value?.startsWith('/requests?')) return '/requests';
  const selected = new URLSearchParams(value.slice('/requests?'.length)).get('category');
  return selected && Object.hasOwn(categories,selected) ? `/requests?category=${encodeURIComponent(selected)}` : '/requests';
}
export function loginLink(role: 'staff' | 'resident', next: string) {
  return (role==='staff'?staffLogin:residentLogin)+'?returnTo='+encodeURIComponent(returnPath(role,next));
}
