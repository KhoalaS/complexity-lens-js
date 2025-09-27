import { parse } from '@typescript-eslint/parser'
import { AST_NODE_TYPES, TSESTree } from '@typescript-eslint/types'

export type ComplexityResult = {
  name: string
  score: number
  start: { line: number; column: number }
  end: { line: number; column: number }
}

function isFunctionNode(
  node: TSESTree.Node
): node is
  | TSESTree.FunctionDeclaration
  | TSESTree.FunctionExpression
  | TSESTree.ArrowFunctionExpression
  | (TSESTree.MethodDefinition & { body?: TSESTree.BlockStatement }) {
  return [
    AST_NODE_TYPES.FunctionDeclaration,
    AST_NODE_TYPES.FunctionExpression,
    AST_NODE_TYPES.ArrowFunctionExpression,
    AST_NODE_TYPES.MethodDefinition,
  ].includes(node.type)
}

export function analyzeText(
  text: string,
  fileName = 'file.ts'
): ComplexityResult[] {
  // crude .vue <script> block extraction (works for simple SFCs). For full fidelity, use @vue/compiler-sfc.
  if (fileName.endsWith('.vue')) {
    const scriptMatch = /<script( [^>]*)?>([\s\S]*?)<\/script>/gi
    const results: ComplexityResult[] = []
    let m: RegExpExecArray | null
    while ((m = scriptMatch.exec(text)) !== null) {
      const script = m[2]
      const offsetLine = text.slice(0, m.index).split('\n').length - 1
      const fromFileResults = analyzeScript(script)
      for (const r of fromFileResults) {
        r.start.line += offsetLine
        r.end.line += offsetLine
        results.push(r)
      }
    }
    return results
  }

  console.debug('Start analyzing', fileName)

  return analyzeScript(text)
}

function analyzeScript(text: string): ComplexityResult[] {
  const ast = parse(text, {
    loc: true,
    range: true,
    ecmaVersion: 2020,
    sourceType: 'module',
    ecmaFeatures: { jsx: true },
  }) as TSESTree.Program

  const results: ComplexityResult[] = []

  // traverse AST and collect top-level function-like nodes
  const visit = (node: TSESTree.Node, parents: TSESTree.Node[]) => {
    if (isFunctionNode(node)) {
      const score = computeForFunction(node)
      const loc = node.loc

      const name = getFunctionName(node, parents) || '<anonymous>'

      console.debug(`Computed score of ${score} for function ${name}`)

      results.push({
        name,
        score,
        start: { line: loc.start.line - 1, column: loc.start.column, },
        end: { line: loc.end.line - 1, column: loc.end.column },
      })

      // do not descend into the function here — computeForFunction will analyze its own body
      //return
    }

    for (const key of Object.keys(node as any)) {
      const child = (node as any)[key]
      if (Array.isArray(child)) {
        for (const c of child) {
          if (c && typeof c.type === 'string') {
            visit(c, parents.concat(node))
          }
        }
      } else if (child && typeof child.type === 'string') {
        visit(child, parents.concat(node))
      }
    }
  }

  visit(ast, [])
  return results
}

function getFunctionName(
  node: TSESTree.Node,
  parents: TSESTree.Node[]
): string | null {
  if (
    node.type === AST_NODE_TYPES.FunctionDeclaration &&
    node.id &&
    node.id.name
  ) {
    return node.id.name
  }
  if (node.type === AST_NODE_TYPES.MethodDefinition) {
    if (node.key) {
      if (node.key.type === AST_NODE_TYPES.Identifier) {
        return node.key.name
      }
      if (node.key.type === AST_NODE_TYPES.Literal) {
        return String(node.key.value)
      }
    }
  }

  // FunctionExpression / ArrowFunctionExpression: try to infer from parent
  const parent = parents[parents.length - 1]
  if (!parent) {
    return null
  }

  // variable assignment: const foo = function() {} or const foo = () => {}
  if (
    parent.type === AST_NODE_TYPES.VariableDeclarator &&
    parent.id &&
    parent.id.type === AST_NODE_TYPES.Identifier
  ) {
    return parent.id.name
  }

  // assignment: foo.bar = function() {}
  if (parent.type === AST_NODE_TYPES.AssignmentExpression) {
    const left = parent.left
    if (left.type === AST_NODE_TYPES.Identifier) {
      return left.name
    }
    if (left.type === AST_NODE_TYPES.MemberExpression) {
      const prop = left.property
      if (prop.type === AST_NODE_TYPES.Identifier) {
        return prop.name
      }
    }
  }

  // object property: { foo: function() {} } or { foo() {} }
  if (
    parent.type === AST_NODE_TYPES.Property ||
    parent.type === AST_NODE_TYPES.PropertyDefinition
  ) {
    const parentKey = parent.key
    if (parentKey.type === AST_NODE_TYPES.Identifier) {
      return parentKey.name
    }
    if (parentKey.type === AST_NODE_TYPES.Literal) {
      return String(parentKey.value)
    }
  }

  return null
}

function computeForFunction(
  fnNode:
    | TSESTree.FunctionDeclaration
    | TSESTree.FunctionExpression
    | TSESTree.ArrowFunctionExpression
    | (TSESTree.MethodDefinition & { body?: TSESTree.BlockStatement })
): number {
  const body = fnNode.body
  let score = 0

  // root function node reference — used to avoid descending into nested functions
  const root = fnNode as TSESTree.Node

  const walk = (
    n: TSESTree.Node | null | undefined,
    nesting: number,
    inCondition: boolean
  ) => {
    if (!n) {
      console.debug('Node is undefined or null', n)
      return
    }

    // do not analyze the contents of nested functions — they are separate units
    if (n !== root && isFunctionNode(n)) {
      console.debug('Seperate function', n.type)
      return
    }

    switch (n.type) {
      case AST_NODE_TYPES.IfStatement: {
        // base increment for the if
        score += 1 + nesting
        // condition: count logical operators inside it
        walk(n.test, nesting, true)
        // consequent and alternate increase nesting
        walk(n.consequent, nesting + 1, false)
        if (n.alternate) {
          walk(n.alternate, nesting + 1, false)
        }
        return
      }

      case AST_NODE_TYPES.ForStatement: {
        score += 1 + nesting
        const fs = n
        if (fs.init) {
          walk(fs.init, nesting, false)
        }
        if (fs.test) {
          walk(fs.test, nesting, true)
        }
        if (fs.update) {
          walk(fs.update, nesting, false)
        }
        walk(fs.body, nesting + 1, false)
        return
      }

      case AST_NODE_TYPES.ForInStatement:
      case AST_NODE_TYPES.ForOfStatement: {
        score += 1 + nesting
        walk(n.left, nesting, false)
        walk(n.right, nesting, true)
        walk(n.body, nesting + 1, false)
        return
      }

      case AST_NODE_TYPES.WhileStatement: {
        score += 1 + nesting
        walk(n.test, nesting, true)
        walk(n.body, nesting + 1, false)
        return
      }

      case AST_NODE_TYPES.DoWhileStatement: {
        score += 1 + nesting
        walk(n.body, nesting + 1, false)
        walk(n.test, nesting, true)
        return
      }

      case AST_NODE_TYPES.SwitchStatement: {
        const ss = n
        // traverse cases — each case with a non-empty consequent counts
        for (const switchCase of ss.cases) {
          const hasConsequent =
            Array.isArray(switchCase.consequent) &&
            switchCase.consequent.length > 0
          if (hasConsequent) {
            score += 1 + nesting // each case increases complexity
          }
          // descend into consequent with increased nesting
          for (const c of switchCase.consequent) walk(c, nesting + 1, false)
        }
        // still walk discriminant (the switch expression) in condition-mode to count boolean ops if present
        if (ss.discriminant) {
          walk(ss.discriminant, nesting, true)
        }
        return
      }

      case AST_NODE_TYPES.ConditionalExpression: {
        // ternary
        score += 1 + nesting
        const ce = n
        walk(ce.test, nesting, true)
        walk(ce.consequent, nesting + 1, false)
        walk(ce.alternate, nesting + 1, false)
        return
      }

      case AST_NODE_TYPES.CatchClause: {
        score += 1 + nesting
        const cc = n
        walk(cc.body, nesting + 1, false)
        return
      }

      case AST_NODE_TYPES.LogicalExpression: {
        // count boolean operators only when inside a condition
        if (inCondition) {
          // each LogicalExpression node corresponds to one operator (&& or ||)
          score += 1
        }
        // still traverse both sides — keep inCondition so chains are fully counted
        const le = n
        walk(le.left, nesting, inCondition)
        walk(le.right, nesting, inCondition)
        return
      }

      default: {
        // generic traversal for any other node
        for (const key of Object.keys(n as any)) {
          const child = (n as any)[key]
          if (Array.isArray(child)) {
            for (const c of child) {
              if (c && typeof c.type === 'string') {
                walk(c, nesting, false)
              }
            }
          } else if (child && typeof child.type === 'string') {
            // if this property name suggests it's a condition, propagate inCondition=true
            const lowerKey = key.toLowerCase()
            const shouldBeCondition =
              lowerKey === 'test' ||
              lowerKey === 'condition' ||
              lowerKey === 'discriminant' ||
              lowerKey === 'expression' ||
              lowerKey === 'predicate'
            walk(child, nesting, shouldBeCondition ? true : false)
          }
        }
        return
      }
    }
  }

  if (body) {
    // body for arrow functions may be an expression
    walk(body, 0, false)
  }

  return score
}
