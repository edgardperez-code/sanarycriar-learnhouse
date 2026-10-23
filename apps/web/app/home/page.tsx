import React from 'react'
import HomeClient from './home'
import type { Metadata } from 'next'
 
// Sanar y Criar: Spanish page title, "Sanar y Criar" fallback.
export const metadata: Metadata = {
  title: 'Inicio | Sanar y Criar',
}
function Home() {
  return (
    <div>
      <HomeClient/>
    </div>
  )
}

export default Home