import React from 'react';
import { Navigate } from 'react-router-dom';

interface Props {
  roles: string[];
  children: React.ReactElement;
}

export default function RequireRole({ roles, children }: Props) {
  const userRaw = localStorage.getItem('user');
  if (!userRaw) return <Navigate to="/login" replace />;
  try {
    const user = JSON.parse(userRaw);
    if (!user || !user.role) return <Navigate to="/login" replace />;
    if (!roles.includes(user.role)) return <Navigate to="/login" replace />;
    return children;
  } catch {
    return <Navigate to="/login" replace />;
  }
}
