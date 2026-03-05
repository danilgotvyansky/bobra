# Authentication & Tokens

Bobra includes a built-in authentication battery that manages API tokens, hashing, and security.

## The Init Token (Bootstrap)

The **Init Token** is the most critical component of Bobra's authentication system. It is a one-time, high-privilege token used to bootstrap the system.

### Purpose
When you first deploy a Bobra-based application, you have no users or organizations. The Init Token allows you to provide authentication for your app initialization actions like:
- Create the first organization.
- Register the first administrative user.
- Configure global settings via the API.

### Generation
The Init Token is generated automatically during the **first database migration**.

- **Detection**: The migration script checks the `init_token_created` table.
- **Output**: If it's the first run, the token is printed to the console log (STDOUT).
- **One-Time**: Once marked as created in the database, the framework will NEVER generate it again.

> [!WARNING]
> **Capture the token immediately!** If you lose the Init Token, you will need to manually reset the `init_token_created` table in your database and re-run migrations to generate a new one.

### Usage
The Init Token is used as a standard Bearer token in the `Authorization` header:

```http
Authorization: Bearer <YOUR_INIT_TOKEN>
```

## Public API Tokens

Beyond the Init Token, Bobra supports standard Public API Tokens for programmatic access.

### Tokens Table
Tokens are stored with:
- `token_hash`: SHA-256 hash of the token.
- `token_salt`: Unique salt for hashing.
- `init_token`: A boolean flag identifying if this is the bootstrap token.

## Service Isolation
For security reasons, the standard `api-token-handler` (which manages regular token CRUD) is **prohibited** from creating or modifying Init Tokens. Init Tokens can only be created by the low-level migration logic, ensuring they cannot be easily compromised via standard API endpoints.
