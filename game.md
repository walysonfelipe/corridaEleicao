# Corrida da Apuração

## Ideia

Uma corrida visual inspirada em jogos de kart. Cada candidato é um competidor na pista, e sua posição acompanha seu percentual dos votos válidos apurados. O foco é assistir à corrida e às mudanças da apuração.

## Abrir o jogo

Sirva a pasta com `python3 -m http.server 8000` e abra `http://localhost:8000` em um navegador moderno. O jogo usa HTML, CSS e JavaScript sem dependências ou etapa de build. A página tenta consultar o TSE; se os arquivos ainda não estiverem publicados ou a conexão falhar, exibe os dados de demonstração identificados como tal.

## Como funciona

- A corrida começa direto na pista, sem menu, cadastro, palpites ou ranking.
- Cada candidato tem uma cor, um kart e uma identificação legível.
- A posição na pista representa o percentual de votos válidos do candidato. Ela não representa a porcentagem de seções apuradas.
- Quando chegam resultados oficiais novos, os karts avançam ou recuam suavemente conforme os percentuais mudam.
- Uma troca de liderança é mostrada como uma ultrapassagem, com destaque visual breve.
- O HUD mostra a posição dos candidatos, seus percentuais, o percentual de seções totalizadas, a fonte dos dados e o horário da última atualização.
- Uma contagem regressiva mostra quanto falta para as 17h (horário de Brasília). Nesse horário, o modo em tempo real é ativado automaticamente e o TSE passa a ser consultado a cada cinco segundos.
- Entre atualizações, a animação continua, mas os karts não inventam mudanças nos resultados.
- A corrida só termina quando a apuração oficial for concluída. Uma liderança parcial não dispara a vitória.
- Quando o TSE marca o resultado como matematicamente definido (`md`), o contador mostra **DEFINIDO** e os candidatos recebem a etiqueta **ELEITO** ou **2º TURNO**, conforme a situação (`st`/`e`) do arquivo EA20. Se o TSE marcar `md` antes de preencher `st`, a página aplica a regra da eleição: mais de 50% dos votos válidos elege; senão, os dois primeiros vão ao 2º turno.
- Quando o arquivo oficial chega a 100% das seções totalizadas (ou à totalização final), abre uma tela própria com quem foi eleito ou quem vai ao 2º turno de Presidente, com os percentuais de votos válidos. Ela abre sozinha uma vez por turno; **Ver a corrida** fecha, e **Ver resultado final**, no cartão do líder, reabre.
- Se o arquivo do TSE ficar mais de 10 minutos sem uma nova geração (antes da totalização final), o selo muda para **TSE SEM ATUALIZAÇÃO** e informa há quanto tempo o arquivo não muda.

## Primeira versão

O protótipo começa direto na pista. Use as setas esquerda/direita para girar a câmera, os botões para alternar entre as visões da pista e `F` para tela cheia. Essas ações não alteram a classificação. O arquivo `game.js` busca a configuração EA11, encontra o código de Presidente e consulta o resultado nacional EA20 a cada 30 segundos. O código usa `s.pst` para a apuração de seções e `cand.vap` sobre os votos válidos para ordenar candidatos. A pista mostra até oito karts; a classificação lista todos. `style.css` define a interface responsiva.

## Simulação da apuração

Antes da divulgação oficial, a página abre com a simulação da apuração rodando sozinha, sem botão para iniciá-la. Ela usa o [ambiente de simulado oficial do TSE](https://www.tse.jus.br/eleicoes/informacoes-tecnicas-sobre-a-divulgacao-de-resultados) (`https://resultados-sim.tse.jus.br/simulado`, ambiente `simulado2026`, eleição 21270). Ele carrega o arquivo final de Presidente desse ambiente (`br-c0001-e021270-u.json`) e reproduz a apuração, do 0% até a totalização final do teste, em cerca de três minutos. A contagem começa devagar, acelera no meio e desacelera no fim. Ao concluir, a simulação espera alguns segundos e recomeça do 0% com novas variações, em loop, como um aquecimento até a divulgação oficial começar; o contador de voltas mostra qual aquecimento está em andamento. Os candidatos são os de teste publicados pelo TSE. A tela identifica tudo como **SIMULADO DO TSE · não é resultado**.

Se o simulado do TSE estiver indisponível, roda uma simulação local com candidatos fictícios (Candidato A a F), identificada como **SIMULAÇÃO**. As duas passam pelo mesmo código que lê os arquivos reais (EA20). Às 17h ela para e o modo em tempo real assume sozinho. O botão **Começar tempo real** fica escondido e só aparece se, 30 segundos depois das 17h, a troca automática não tiver acontecido; depois disso, vira **Tentar conectar ao TSE** enquanto os dados oficiais não chegarem ou após três falhas seguidas de consulta.

O modo real continua funcionando durante a simulação. A consulta ao ambiente `oficial` (eleição 6257, 1º turno em 04/10/2026) começa às 17h (horário de Brasília). Se um arquivo oficial chegar durante a simulação, ele é guardado e aparece quando a simulação termina.

## Dados

O protótipo consulta os arquivos públicos do TSE em `https://resultados.tse.jus.br/oficial`. Ele respeita a eleição e os diretórios anunciados na configuração EA11 e consome EA20 para o resultado nacional de Presidente. A tela identifica a fonte e a geração do arquivo. Se os dados não estiverem publicados ou estiverem indisponíveis, mantém o placar ilustrativo claramente identificado; falhas sucessivas usam espera progressiva para evitar excesso de consultas.

Referências: [informações técnicas de divulgação do TSE](https://www.tse.jus.br/eleicoes/informacoes-tecnicas-sobre-a-divulgacao-de-resultados) e [especificação EA20](https://www.tse.jus.br/eleicoes/eleicoes-2026-content/arquivos/divulgacao-de-resultados/tse-ea20-arquivo-de-resultado-unificado).
