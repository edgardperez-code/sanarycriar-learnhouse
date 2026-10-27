'use client'
// Sanar y Criar: "Pedidos", the Pago Móvil orders of the cart. Behind the
// payments feature like the rest of Pagos; the API enforces the org-admin
// permission. Accepts ?code=SYC-XXXXXX to open that order.
import React, { Suspense, use } from 'react'
import FeatureGate from '@components/Dashboard/Shared/FeatureGate/FeatureGate'
import OrdersPage from '@components/Dashboard/Pages/Orders/OrdersPage'

export default function OrdersRoute(props: { params: Promise<{ orgslug: string }> }) {
  const params = use(props.params)
  return (
    <FeatureGate feature="payments">
      {/* useSearchParams (?code=) needs a Suspense boundary. */}
      <Suspense fallback={null}>
        <OrdersPage orgslug={params.orgslug} />
      </Suspense>
    </FeatureGate>
  )
}
