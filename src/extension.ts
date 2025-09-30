import * as vscode from 'vscode'
import { analyzeText } from './cognitive'

let diagnosticCollection: vscode.DiagnosticCollection
let statusBar: vscode.StatusBarItem

export function activate(context: vscode.ExtensionContext) {
  diagnosticCollection = vscode.languages.createDiagnosticCollection('cl')
  context.subscriptions.push(diagnosticCollection)

  statusBar = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Left,
    100
  )
  context.subscriptions.push(statusBar)

  const scanCmd = vscode.commands.registerCommand('cl.scan', () => {
    const editor = vscode.window.activeTextEditor
    if (editor) {
      runAnalysis(editor.document)
    }
  })
  context.subscriptions.push(scanCmd)

  // analyze when documents are opened or saved
  context.subscriptions.push(
    vscode.workspace.onDidOpenTextDocument(runAnalysis)
  )
  context.subscriptions.push(
    vscode.workspace.onDidSaveTextDocument(runAnalysis)
  )
  context.subscriptions.push(
    vscode.workspace.onDidChangeTextDocument((e) => runAnalysis(e.document))
  )
  context.subscriptions.push(
    vscode.window.onDidChangeActiveTextEditor((e) => {
      if (e) {
        runAnalysis(e.document)
        updateStatusBar(e.document.uri)
      }
    })
  )

  context.subscriptions.push(
    vscode.languages.registerCodeLensProvider(
      [
        { language: 'javascript' },
        { language: 'javascriptreact' },
        { language: 'typescript' },
        { language: 'typescriptreact' },
        { language: 'vue' },
      ],
      new ComplexityCodeLensProvider()
    )
  )

  // initial pass for currently open editor
  if (vscode.window.activeTextEditor) {
    runAnalysis(vscode.window.activeTextEditor.document)
  }
}

export function deactivate() {
  diagnosticCollection?.dispose()
  statusBar?.dispose()
}

function runAnalysis(document: vscode.TextDocument) {
  const lang = document.languageId
  if (
    ![
      'javascript',
      'javascriptreact',
      'typescript',
      'typescriptreact',
      'vue',
    ].includes(lang)
  ) {
    return
  }

  const text = document.getText()
  const results = analyzeText(text, document.fileName)

  diagnosticCollection.clear()
  const diagnostics: vscode.Diagnostic[] = []

  let maxScore = 0

  for (const r of results) {
    maxScore = Math.max(maxScore, r.score)

    const range = new vscode.Range(
      new vscode.Position(r.start.line, r.start.column),
      new vscode.Position(r.end.line, r.end.column)
    )

    const message = `Cognitive Complexity: ${r.score}`
    const severity =
      r.score >= 15
        ? vscode.DiagnosticSeverity.Error
        : r.score >= 10
        ? vscode.DiagnosticSeverity.Warning
        : vscode.DiagnosticSeverity.Information

    if (
      severity === vscode.DiagnosticSeverity.Error ||
      severity === vscode.DiagnosticSeverity.Warning
    ) {
      console.log('setting diagnostics')
      const diag = new vscode.Diagnostic(range, message, severity)
      diagnostics.push(diag)
    }
  }

  diagnosticCollection.set(document.uri, diagnostics)

  updateStatusBar(document.uri, maxScore)
}

function updateStatusBar(uri: vscode.Uri, maxScoreFromRun?: number) {
  let maxScore = maxScoreFromRun ?? 0
  if (maxScore === 0) {
    const diags = diagnosticCollection.get(uri) || []
    for (const d of diags) {
      const m = d.message.match(/Cognitive Complexity: (\d+)/)
      if (m) {
        maxScore = Math.max(maxScore, parseInt(m[1], 10))
      }
    }
  }
  statusBar.text = `Cog. Complexity: ${maxScore}`
  statusBar.show()
}

class ComplexityCodeLensProvider implements vscode.CodeLensProvider {
  provideCodeLenses(
    document: vscode.TextDocument,
    _token: vscode.CancellationToken
  ) {
    const results = analyzeText(document.getText(), document.fileName)
    const lenses: vscode.CodeLens[] = []

    for (const r of results) {
      const range = new vscode.Range(
        new vscode.Position(r.start.line, 0),
        new vscode.Position(r.start.line, 0)
      )
      lenses.push(
        new vscode.CodeLens(range, {
          title: `Cognitive Complexity: ${r.score}`,
          command: '', // empty means it's just a label, no action
        })
      )
    }

    return lenses
  }
}
