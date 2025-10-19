# Contributing to BullMQ Workflows

Thank you for your interest in contributing! This document provides guidelines and instructions for contributing to BullMQ Workflows.

## Table of Contents

- [Code of Conduct](#code-of-conduct)
- [Getting Started](#getting-started)
- [Development Setup](#development-setup)
- [Project Structure](#project-structure)
- [Making Changes](#making-changes)
- [Testing](#testing)
- [Code Style](#code-style)
- [Submitting Changes](#submitting-changes)
- [Release Process](#release-process)

## Code of Conduct

Be respectful, inclusive, and professional. We're all here to build something great together.

## Getting Started

### Prerequisites

- Node.js >= 18
- Bun >= 1.0 (recommended for development)
- Redis (for running tests and examples)
- Git

### Fork and Clone

1. Fork the repository on GitHub
2. Clone your fork locally:

```bash
git clone https://github.com/YOUR_USERNAME/bun-workflows.ts.git
cd bun-workflows.ts
```

3. Add upstream remote:

```bash
git remote add upstream https://github.com/ORIGINAL_OWNER/bun-workflows.ts.git
```

## Development Setup

### Install Dependencies

```bash
bun install
```

### Start Redis

The project requires Redis for testing and examples:

```bash
# Using Docker
docker-compose up -d

# Or install Redis locally and start it
redis-server
```

### Run Tests

```bash
bun run test
```

### Run Examples

```bash
cd examples/simple-dev
bun run start
```

## Project Structure

```
bun-workflows.ts/
├── packages/
│   └── bullmq-workflows/          # Core library
│       ├── src/
│       │   └── lib/workflows/      # Workflow engine implementation
│       │       ├── types.ts        # TypeScript types
│       │       ├── workflow-engine.ts
│       │       ├── workflow-entrypoint.ts
│       │       ├── workflow-step.ts
│       │       ├── workflow-worker.ts
│       │       ├── workflow.ts
│       │       ├── workflow-instance.ts
│       │       ├── utils.ts
│       │       └── __tests__/      # Unit tests
│       ├── index.ts                # Package entry point
│       └── package.json
├── examples/                       # Example applications
├── docs/                           # Documentation
└── README.md
```

## Making Changes

### Branch Naming

Create a descriptive branch for your changes:

```bash
git checkout -b feature/add-workflow-events
git checkout -b fix/step-timeout-bug
git checkout -b docs/improve-api-reference
```

### Commit Messages

Write clear, concise commit messages:

```bash
# Good
git commit -m "feat: add workflow event listener support"
git commit -m "fix: handle timeout in nested steps correctly"
git commit -m "docs: update API reference for WorkflowStep"

# Bad
git commit -m "fix stuff"
git commit -m "WIP"
git commit -m "asdf"
```

Follow [Conventional Commits](https://www.conventionalcommits.org/):

- `feat:` New feature
- `fix:` Bug fix
- `docs:` Documentation only
- `style:` Code style (formatting, no logic change)
- `refactor:` Code refactor
- `test:` Adding/updating tests
- `chore:` Maintenance tasks

### What to Work On

#### Good First Issues

Look for issues labeled `good first issue` - these are beginner-friendly:

- Documentation improvements
- Example additions
- Test coverage
- Bug fixes with clear reproduction steps

#### High Priority

- Critical bugs
- Performance improvements
- Feature requests with community interest

#### Areas We Need Help With

1. **Documentation**

   - API examples
   - Use case guides
   - Tutorial videos

2. **Testing**

   - Edge case coverage
   - Integration tests
   - Performance benchmarks

3. **Examples**

   - Framework integrations (Express, Fastify, Next.js)
   - Real-world patterns (saga, orchestration)
   - Platform examples (AWS, GCP, Azure)

4. **Features**
   - `step.sleep()` implementation
   - `step.waitForEvent()` implementation
   - Workflow composition
   - Observability improvements

## Testing

### Running Tests

```bash
# Run all tests
bun test

# Run tests in watch mode
bun test --watch

# Run tests with coverage
bun test --coverage

# Run specific test file
bun test src/lib/workflows/__tests__/workflow-step.test.ts
```

### Writing Tests

Place tests in `__tests__` directories next to the code they test:

```typescript
import { describe, expect, it } from "bun:test";
import { WorkflowStep } from "../workflow-step";

describe("WorkflowStep", () => {
  it("should cache step results", async () => {
    // Test implementation
  });

  it("should handle errors correctly", async () => {
    // Test implementation
  });
});
```

### Test Requirements

- All new features must include tests
- Bug fixes should include regression tests
- Aim for >80% code coverage
- Tests must pass before PR is merged

## Code Style

### Linting and Formatting

We use Biome (via Ultracite) for linting and formatting:

```bash
# Check code style
bun run check

# Auto-fix issues
bun run check:fix
```

### TypeScript Guidelines

- Use TypeScript for all code
- Avoid `any` type
- Prefer interfaces over type aliases for public APIs
- Export types that consumers might need
- Use generics for reusable components

### Code Style Rules

**Good:**

```typescript
// Use arrow functions
const processOrder = async (orderId: string): Promise<Order> => {
  return await fetchOrder(orderId);
};

// Use const for variables that don't change
const result = await step.do("process", async () => {...});

// Destructure where appropriate
const { userId, orderId } = event.payload;

// Use template literals
console.log(`Processing order ${orderId}`);
```

**Avoid:**

```typescript
// Don't use var
var x = 1;

// Don't use function declarations
function processOrder() {}

// Don't use any
const result: any = await doSomething();

// Don't use unnecessary nesting
if (condition) {
  if (anotherCondition) {
    if (yetAnother) {
      // Do something
    }
  }
}
```

## Submitting Changes

### Before Submitting

1. **Update Documentation**

   - Update API.md if adding/changing public APIs
   - Update README.md if needed
   - Add/update examples

2. **Add Tests**

   - Unit tests for new functionality
   - Integration tests if applicable
   - Update existing tests if behavior changed

3. **Run Quality Checks**

   ```bash
   bun run check      # Lint
   bun test           # Tests
   bun run build      # Ensure it builds
   ```

4. **Update CHANGELOG** (if applicable)
   - Add entry under "Unreleased"
   - Include type (feat, fix, etc.)
   - Link to relevant issues

### Creating a Pull Request

1. **Push to Your Fork**

   ```bash
   git push origin feature/my-feature
   ```

2. **Open PR on GitHub**

   - Clear title summarizing the change
   - Detailed description of what and why
   - Link to related issues
   - Include screenshots/videos if UI changes

3. **PR Template**

   ```markdown
   ## Description

   Brief description of the change

   ## Type of Change

   - [ ] Bug fix
   - [ ] New feature
   - [ ] Breaking change
   - [ ] Documentation update

   ## Testing

   - [ ] Tests added/updated
   - [ ] All tests passing
   - [ ] Manual testing completed

   ## Checklist

   - [ ] Code follows style guidelines
   - [ ] Documentation updated
   - [ ] No breaking changes (or documented)
   - [ ] CHANGELOG updated
   ```

### Review Process

1. **Automated Checks**

   - CI runs tests
   - Linting is checked
   - Build succeeds

2. **Code Review**

   - Maintainer reviews code
   - May request changes
   - Discussion and iteration

3. **Approval and Merge**
   - Once approved, PR is merged
   - Usually squashed into single commit

## Release Process

(For maintainers)

### Version Bumping

Follow [Semantic Versioning](https://semver.org/):

- **Major**: Breaking changes (1.0.0 → 2.0.0)
- **Minor**: New features, backwards compatible (1.0.0 → 1.1.0)
- **Patch**: Bug fixes (1.0.0 → 1.0.1)

### Release Steps

1. Update version in `package.json`
2. Update CHANGELOG.md
3. Commit: `git commit -m "chore: release v1.2.3"`
4. Tag: `git tag v1.2.3`
5. Push: `git push origin main --tags`
6. Publish: `npm publish` (after building)

## Development Tips

### Debugging

```typescript
// Add debug logging
console.log("[DEBUG] Step result:", result);

// Use Bun debugger
debugger;  // Set breakpoint

// Check Redis state
redis-cli
> KEYS workflow:*
> HGETALL workflow:instance-123:state
```

### Testing Workflows Locally

```bash
# Terminal 1: Start Redis
docker-compose up redis

# Terminal 2: Run example
cd examples/simple-dev
bun run start

# Terminal 3: Monitor Redis
redis-cli MONITOR
```

### Common Issues

**Redis connection errors:**

```bash
# Check if Redis is running
redis-cli ping
# Should return: PONG
```

**Tests failing:**

```bash
# Clear Redis between test runs
redis-cli FLUSHALL
```

**Type errors:**

```bash
# Rebuild types
bun run build
```

## Questions?

- Open an issue for bugs or features
- Start a discussion for questions or ideas
- Join our community chat (if available)

## License

By contributing, you agree that your contributions will be licensed under the MIT License.

---

Thank you for contributing to BullMQ Workflows! 🎉
