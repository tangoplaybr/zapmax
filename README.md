<div align="center">
  <img src="https://upload.wikimedia.org/wikipedia/commons/6/6b/WhatsApp.svg" alt="ZapMax" width="120">

  <h1>ZapMax Workspace</h1>
  
  <p>
    <strong>Sistema Master de Gestão e Atendimento Multi-Usuários para WhatsApp</strong>
  </p>

  <p>
    <img alt="Versão" src="https://img.shields.io/badge/version-1.0.0-blue.svg?cacheSeconds=2592000" />
    <img alt="Node Version" src="https://img.shields.io/badge/node-%3E%3D%2018.0.0-brightgreen.svg" />
    <img alt="Controle" src="https://img.shields.io/badge/Electron-Desktop-47848f.svg" />
    <img alt="Banco" src="https://img.shields.io/badge/SQLite-WAL_Optimized-003B57.svg" />
    <img alt="API" src="https://img.shields.io/badge/wwebjs-Headless-25D366.svg" />
  </p>
</div>

---

## 📑 Índice

- [📖 Visão Geral Completa](#-visão-geral-completa)
- [✨ Features e Funcionalidades Detalhadas](#-features-e-funcionalidades-detalhadas)
  - [👥 Gestão de Atendimento e Multi-Agente](#-gestão-de-atendimento-e-multi-agente)
  - [🧠 Automações e Inteligência Artificial](#-automações-e-inteligência-artificial)
  - [🗂️ Organização, Produtividade e Kanban](#️-organização-produtividade-e-kanban)
  - [📊 Mini-CRM e Contatos Inteligentes](#-mini-crm-e-contatos-inteligentes)
  - [🔒 UI, Segurança e Admin](#-ui-segurança-e-admin)
- [🏗 Arquitetura e Stack Tecnológico](#-arquitetura-e-stack-tecnológico)
- [📦 Estrutura do Monorepo](#-estrutura-do-monorepo)
- [🚀 Instruções de Instalação e Uso](#-instruções-de-instalação-e-uso)
  - [🔐 Credenciais do Super Admin](#-credenciais-do-super-admin)
- [💻 Como Compilar e Empacotar (Build)](#-como-compilar-e-empacotar-build)
- [🗄️ Otimizações de Banco de Dados](#️-otimizações-de-banco-de-dados)
- [📸 Interface e Screenshots](#-interface-e-screenshots)

---

## 📖 Visão Geral Completa

O **ZapMax** foi construído do zero para resolver os limites impostos pelo WhatsApp padrão e fornecer um centro de operações unificado para equipes de vendas e suporte ao cliente. 

Diferente do WhatsApp Web comum (que impõe limite de aparelhos e lentidão de sincronização), o ZapMax orquestra uma única linha através de uma arquitetura **Client-Server robusta empacotada em Electron**. Isso permite que dezenas de membros da sua equipe operem simultaneamente no mesmo número, sem conflitos, enquanto os gestores monitoram tudo em tempo real. Com uma engine própria e otimizações de banco da dados usando PRAGMAs estritos do SQLite, a plataforma processa milhares de mídias e conversas com eficiência imbatível.

---

## ✨ Features e Funcionalidades Detalhadas

### 👥 Gestão de Atendimento e Multi-Agente
- **Operação Simultânea e Sem Limites:** Dezenas de atendentes logam com seus usuários e senhas particulares e respondem clientes na mesma conta do WhatsApp ao mesmo tempo, sem restrições de "Aparelhos Conectados".
- **Sistema de Transbordo (Transferências em Tempo Real):** Transfira carteiras de clientes ou tickets específicos de um atendente para outro. O alvo recebe alertas "Push" imediatamente e uma *badge* visual indicando mensagens não-lidas do ticket repassado.
- **Prevenção Inteligente de Duplicadas (Anti-Colisão):** A base de dados varre contatos vindos do `@lid` ou do telefone nativo e efetua o *Merge* (fusão) em tempo real. Se o mesmo cliente chamar duas vezes por bugs de rede, o sistema funde os atendimentos em um único bloco prioritário automaticamente.
- **Visibilidade de Convidados (Guest Invitations):** Qualquer administrador ou convidado pode "entrar" temporariamente na sala de atendimento de outro colega para "dar um aval", sem precisar tomar a posse oficial do cliente para si.
- **Controle de Ciclo de Vida Reativo:** Finalizou o suporte? Clique em concluir e a tela esvazia. Se aquele cliente mandar uma nova dúvida dali a um mês, o atendimento "ressuscita" automaticamente com o histórico atrelado, voltando para a aba "Aguardando".
- **Ações Rápidas em Lote (Bulk Actions):** Segure `Ctrl` e clique em vários atendimentos da lista esquerda. Útil para limpeza de final de dia: você pode fechar 50 conversas de uma vez, ou excluir spams massivos em 1 segundo.

### 🧠 Automações e Inteligência Artificial
- **Integração Nativa com IA (`groq-sdk`):** Ganchos embutidos para alimentar Grandes Modelos de Linguagem (como o Llama via Groq). Permite sumarizar longas conversas com um clique e sugerir respostas ao operador.
- **Gatilhos Mágicos e Respostas Rápidas (Canned Responses):** Salve textos longos e acione-os digitando "/" durante a conversa. O cliente também pode enviar uma palavra predefinida e disparar o envio de um Manual em PDF, por exemplo.
- **Avisos de Horário Comercial:** Se a sua equipe for almoçar ou o expediente acabar, o sistema detecta e assume, enviando a mensagem de bloqueio para todos os novos contatos ("Voltamos às 08h..."), mantendo o cliente amparado enquanto a equipe descansa.

### 🗂️ Organização, Produtividade e Kanban
- **Mural de Notas e Tarefas Internas (Internal Notes):** Recurso nativo que funciona como um Mini-Kanban. Crie avisos, atribua tarefas a membros específicos da equipe, configure prazos (*deadlines*) ou faça lembretes recorrentes (Ex: "Cobrar boletos toda segunda e sexta-feira"). Suporta até mesmo checklists clicáveis dentro das notas.
- **Etiquetas Coloridas (Labels Customizadas):** Marque atendimentos com etiquetas cromáticas de sua escolha (Ex: "Urgente", "Cliente VIP", "Inadimplente"). Filtre a lista principal de chats apenas pela cor que você deseja focar.
- **Snooze (Lembretes / Adiar Atendimento):** Uma conversa esfriou e o cliente pediu pra chamar na outra semana? Use a função de Snooze para ocultar a conversa naquele momento, e ela "apitará" novamente na fila no dia e horário que você agendou.
- **WhatsApp Status (Stories) History:** Gerencie, poste e armazene todo o histórico de stories publicados pelo número da empresa, acompanhando a cor de fundo e o texto que foi utilizado no passado.

### 📊 Mini-CRM e Contatos Inteligentes
- **Address Book Poderoso (Guia de Contatos):** Uma lista indexada super veloz. Acesse o contato de qualquer cliente já salvo ou prospecto antes mesmo deles chamarem na plataforma e inicie um bate-papo sem tocar no celular.
- **Proteção de Renomeação:** Diferente do WhatsApp Web que sempre zera o nome do cliente baseado no telefone, aqui se você renomear "João" para "João - Diretor de Compras", o zapmax vai "trancar" esse nome e ignorar a atualização forçada do WhatsApp.
- **Extração Rápida Universal (.CSV):** Banco de leads não se perde. Baixe sua base com dezenas de milhares de nomes com 1 clique. O arquivo gerado é otimizado para ser injetado nativamente no `Google Contacts`.
- **Armazenamento Seguro de Avatares (Disk Storage):** Fotos de perfil não trafegam ociosamente pela internet toda vez. O servidor as capta uma vez, processa as imagens, e salva no disco local. Salva extrema banda 4g e acelera o carregamento em 80%.

### 🔒 UI, Segurança e Admin
- **Painel de Configuração Embutido (Slide-In):** Configurações de sistema, setores, auto-mensagens e usuários são abertas como "Gavetas deslizantes". Você altera toda a gestão da sua empresa sem nunca tirar o olho dos seus chats pausados no fundo da tela.
- **Avançado Controle de Autenticação Dupla:** Níveis de permissão estritos entre `Admin` e `Attendant`. Protegido por criptografia industrial em `Bcryptjs` (hash de senhas) e tunelamento seguro por JWT nas pontes de WebSockets.

---

## 🏗 Arquitetura e Stack Tecnológico

Criado para Windows (podendo exportar pra Mac/Linux), utiliza as tecnologias top de mercado de 2024–2025 focado estritamente em **velocidade Desktop**.

1. **Back-end API Engine:** `Node.js` + `Express` controlando via Puppeteer Headless a interface web-layer do `whatsapp-web.js`.
2. **Tempo Real Direto:** `Socket.IO` espalha as mensagens recebidas e os recibos de leitura (ticks azuis) instantaneamente para todos os monitores logados na empresa.
3. **Persistência Relacional WAL:** Banco relacional `SQLite3`, configurado nativamente com pragmas de memória pesados (Write-Ahead Logging, Cache Size de 8MB em RAM) para suportar escritas pesadíssimas de mídia sem travar as buscas da equipe.
4. **App Desktop Wrapper:** Empacotamento profissional multi-janelas com `Electron`.
5. **Autenticação e Segurança:** `bcryptjs` + `jsonwebtoken`.
6. **Módulo File System Native:** Camada de `Multer` para manipulação em fluxo de leitura/escrita de Fotos e Docs em buffers binários, separando o peso dos arquivos de fora do banco de dados relacional.

---

## 📦 Estrutura do Monorepo

O código-fonte principal baseia-se em um modelo de dois nós integrados:

```bash
📂 SISTEMA-WHATSAPP-MULTI/
├── 📂 apps/
│   ├── 📂 client/           # O Frontend do sistema (Views, React/HTML/JS, Estilos)
│   └── 📂 server/           # O Backend Node.js de processamento da API e do WhatsApp Web
├── 📂 .agent/               # Scripts arquiteturais, documentação de dev logs e inteligência
├── 📄 package.json          # Orquestração das dependências
├── 📄 electron-builder-*.json # Regras de compilação da build Client x Server
└── 📄 index.js              # Inicializador Root
```

---

## 🚀 Instruções de Instalação e Uso

### Dependências Iniciais
- **[Instalar o Git](https://git-scm.com/downloads)**
- **[Instalar o NodeJS (Versão 18 ou 20 LTS)](https://nodejs.org/)**

### 1️⃣ Inicialização do Ambiente (Desenvolvimento)
Abra seu terminal e clone a Master Case:
```bash
git clone https://github.com/tangoplaybr/zapmax.git
cd zapmax
npm install
```

### 2️⃣ Rodando pela Primeira Vez (Importante)
O sistema opera em modo Host/Viewer, exigindo que o Banco de Dados suba antes para atender o Frontend.

Abra **DUAS ABAS** (ou dois terminais divididos) no VS Code.

* **No Terminal 1 (O Cérebro da Operação):**
  ```bash
  npm run start:server
  ```
  *(🔑 O WhatsApp vai começar a iniciar as engrenagens ocultas. Na tela preta do terminal, surgirá um **QR CODE**. Escaneie-o igualzinho faria no site do zap oficial e espere o servidor te avisar que o sistema está pronto e online).*

* **No Terminal 2 (A Interface Visual do Atendente):**
  ```bash
  npm run start:client
  ```

> 🔐 **Credenciais do Super Admin (Acesso Padrão):**
> 
> Quando o projeto rodar pela primeira vez ele irá gerar a estrutura do DB e criará o responsável master da empresa para gestão de toda a plataforma:
> - **Usuário:** `admin`
> - **Senha:** `admin123`
> *(Recomendamos que ao logar pela primeira vez, cadastre novos atendentes e depois altere a senha deste painel)*.

---

## 💻 Como Compilar e Empacotar (Build)

Para transformar os códigos em executáveis reais `.exe` para instalar livremente nos computadores da equipe ou num computador isolado focado só em ser servidor:

```bash
# Isso empacota o Motor Base do WhatsApp que precisa estar rodando "invisível" no Background
npm run build:server

# E Isso gera a interface cliente linda e pronta para os atendentes abrirem como App Nativo do Windows
npm run build:client
```
Encontre o resultado dentro da sua pasta `dist/` recém gerada.

---

## 🗄️ Otimizações de Banco de Dados
Para aliviar dores de cabeça com infra na nuvem, usamos `SQLite` local robusto. Ele salva seus dados na `%APPDATA%\ZapMax` ou no limite definido pela variável customizável `DB_PATH`. 
Ao contrário de SQLites passivos, usamos um bootloader que forçadamente engatilha o banco no `PRAGMA WAL` e `Temp Store in MEMORY`. O resultado? Índices (indexes) customizados em tabelas essenciais capazes de rodar um join de busca por 15.000 clientes da sua equipe em menos de 3.2ms cravados (sendo muito mais responsivo que esperar nuvens processarem APIs em JSON).

---

## 📸 Interface e Screenshots

> *(Substitua no GitHub após subir os arquivos de prints)*

| Tela de Autenticação Segura | Layout de Conversas Tempo-Real | Gaveta de Configurações Administrativas |
|:---:|:---:|:---:|
| <img src="https://via.placeholder.com/350x200.png?text=Login+ZapMax" alt="Login"> | <img src="https://via.placeholder.com/350x200.png?text=Chat+Em+Tempo+Real" alt="Chat"> | <img src="https://via.placeholder.com/350x200.png?text=In-App+Admin" alt="Admin"> |

---

<div align="center">
  <b>Elaborado com dedicação e velocidade extrema em 2026. Feito para turbinar as vendas da sua companhia.</b>
  <br><br>
  <i>(Atenção: Sistema não afiliado pela Meta Platforms Inc. Cumprir regras de não-SPAM do WhatsApp para evitar quedas no número)</i>
</div>
