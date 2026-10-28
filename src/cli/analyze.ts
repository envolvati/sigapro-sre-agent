import { IncidentRCAUseCase } from 'usecases/incident-rca'

async function main() {
  const traceId = process.argv[2]
  if (!traceId) {
    console.error('Uso: pnpm analyze <trace_id>')
    process.exit(1)
  }

  console.log(`🤖 Analisando Trace ID: ${traceId}...`)
  const useCase = new IncidentRCAUseCase()
  const result = await useCase.execute({
    alertName: 'Análise Solicitada via CLI',
    traceId,
  })

  if (result.success) {
    console.log('\n✅ Diagnóstico gerado com sucesso!\n')
    console.log(result.rca)
  } else {
    console.error('\n❌ Falha na análise do trace:', result.error)
    process.exit(1)
  }
}

main()
