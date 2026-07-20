# Convex demo boundary

This task board is an intentionally unauthenticated, public demo. Its public Convex functions are internet-callable and exist only to prove that the frontend and Convex deployment are connected.

- All records are disposable demo data. They must not contain secrets, personal data, customer data, or operational instructions.
- Stage and production use separate Convex deployments, so their records cannot cross environments. Both deployments are permanent, stable delivery targets; only their records are disposable demo data. They must never share production or sensitive tables with another application.
- The API is limited to listing up to 50 tasks, storing at most 100 tasks per deployment, creating a normalized task title of at most 120 characters, and toggling an existing task. It exposes no admin or privileged operation.
- Every public function declares runtime argument and return validators. Any future privileged operation must be authenticated or implemented as an internal Convex function.
- `VITE_CONVEX_URL` is a public identifier, never a secret. Supply it as a Docker build argument and rebuild the static bundle when the deployment changes.
