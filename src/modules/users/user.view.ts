import type { UserRole } from '../../common/auth/actor';
import type { User } from '../../generated/prisma/client';

/** Matches the frontend `User` type. Never includes the password hash. */
export interface UserView {
  id: string;
  name: string;
  username: string;
  email: string;
  phone: string;
  role: UserRole;
  active: boolean;
}

export const toUserView = (user: User, role: UserRole): UserView => ({
  id: user.id,
  name: user.name,
  username: user.username,
  email: user.email,
  phone: user.phone,
  role,
  active: user.active,
});
